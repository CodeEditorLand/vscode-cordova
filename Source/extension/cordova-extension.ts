// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as fs from "fs";
import * as path from "path";
import * as semver from "semver";
import * as vscode from "vscode";
import * as nls from "vscode-nls";

import customRequire from "../common/customRequire";
import { CordovaProjectHelper } from "../utils/cordovaProjectHelper";
import { findFileInFolderHierarchy } from "../utils/extensionHelper";
import { Telemetry } from "../utils/telemetry";
import { TelemetryHelper } from "../utils/telemetryHelper";
import { TsdHelper } from "../utils/tsdHelper";
import { IonicCompletionProvider } from "./completionProviders";
import { CordovaSessionManager } from "./cordovaSessionManager";
import { CordovaWorkspaceManager } from "./cordovaWorkspaceManager";
import { CordovaDebugConfigProvider } from "./debugConfigurationProvider";
import { ProjectsStorage } from "./projectsStorage";
import { PluginSimulator } from "./simulate";

nls.config({
	messageFormat: nls.MessageFormat.bundle,
	bundleFormat: nls.BundleFormat.standalone,
})();

const localize = nls.loadMessageBundle();

const PLUGIN_TYPE_DEFS_FILENAME = "pluginTypings.json";

const PLUGIN_TYPE_DEFS_PATH = findFileInFolderHierarchy(
	__dirname,
	PLUGIN_TYPE_DEFS_FILENAME,
);

const CORDOVA_TYPINGS_QUERYSTRING = "cordova";

const JSCONFIG_FILENAME = "jsconfig.json";

const TSCONFIG_FILENAME = "tsconfig.json";

let EXTENSION_CONTEXT: vscode.ExtensionContext;
/**
 * We initialize the counter starting with a large value in order
 * to not overlap indices of the workspace folders originally generated by VS Code
 * {@link https://code.visualstudio.com/api/references/vscode-api#WorkspaceFolder}
 */
let COUNT_WORKSPACE_FOLDERS = 9000;

export function activate(context: vscode.ExtensionContext): void {
	// Asynchronously enable telemetry
	Telemetry.init(
		"cordova-tools",
		customRequire(findFileInFolderHierarchy(__dirname, "package.json"))
			.version,
		{ isExtensionProcess: true, projectRoot: "" },
	);

	EXTENSION_CONTEXT = context;

	const activateExtensionEvent =
		TelemetryHelper.createTelemetryActivity("activate");

	try {
		EXTENSION_CONTEXT.subscriptions.push(
			vscode.workspace.onDidChangeWorkspaceFolders((event) =>
				onChangeWorkspaceFolders(event),
			),
		);

		const configProvider = new CordovaDebugConfigProvider();

		EXTENSION_CONTEXT.subscriptions.push(
			vscode.debug.registerDebugConfigurationProvider(
				"cordova",
				configProvider,
			),
		);

		const cordovaFactory = new CordovaSessionManager();

		EXTENSION_CONTEXT.subscriptions.push(
			vscode.debug.registerDebugAdapterDescriptorFactory(
				"cordova",
				cordovaFactory,
			),
		);

		const workspaceFolders:
			| ReadonlyArray<vscode.WorkspaceFolder>
			| undefined = vscode.workspace.workspaceFolders;

		if (workspaceFolders) {
			registerCordovaCommands();

			workspaceFolders.forEach((folder: vscode.WorkspaceFolder) => {
				onFolderAdded(folder);
			});
		}

		activateExtensionEvent.properties["cordova.workspaceFoldersCount"] =
			workspaceFolders.length;

		Telemetry.send(activateExtensionEvent);
	} catch (e) {
		activateExtensionEvent.properties["cordova.error"] = true;

		Telemetry.send(activateExtensionEvent);

		throw e;
	}
}

export function deactivate(): void {
	console.log("Extension has been deactivated");
}

function onChangeWorkspaceFolders(event: vscode.WorkspaceFoldersChangeEvent) {
	if (event.removed.length) {
		event.removed.forEach((folder) => {
			onFolderRemoved(folder);
		});
	}

	if (event.added.length) {
		event.added.forEach((folder) => {
			onFolderAdded(folder);
		});
	}
}

export function createAdditionalWorkspaceFolder(
	folderPath: string,
): vscode.WorkspaceFolder | null {
	if (fs.existsSync(folderPath)) {
		return {
			uri: vscode.Uri.file(folderPath),
			name: path.basename(folderPath),
			index: COUNT_WORKSPACE_FOLDERS + 1,
		};
	}

	return null;
}

export function onFolderAdded(folder: vscode.WorkspaceFolder): void {
	const workspaceRoot = folder.uri.fsPath;

	if (!CordovaProjectHelper.isCordovaProject(workspaceRoot)) {
		vscode.window.showWarningMessage(
			localize(
				"NoCordovaProjectInWorkspaceRootAndNeedToUpdateCwdArgument",
				"No Cordova project found in workspace root: '{0}'. If project is in subfolder, please make sure the 'cwd' argument in launch.json is updated to the project root.",
				workspaceRoot,
			),
		);

		return;
	}

	// Send project type to telemetry for each workspace folder
	const cordovaProjectTypeEvent = TelemetryHelper.createTelemetryEvent(
		"cordova.projectType",
	);

	TelemetryHelper.determineProjectTypes(workspaceRoot)
		.then((projType) => {
			cordovaProjectTypeEvent.properties.projectType =
				TelemetryHelper.prepareProjectTypesTelemetry(projType);
		})
		.finally(() => {
			Telemetry.send(cordovaProjectTypeEvent);
		});

	// We need to update the type definitions added to the project
	// as and when plugins are added or removed. For this reason,
	// setup a file system watcher to watch changes to plugins in the Cordova project
	// Note that watching plugins/fetch.json file would suffice

	const watcher = vscode.workspace.createFileSystemWatcher(
		"**/plugins/fetch.json",
		false /* ignoreCreateEvents*/,
		false /* ignoreChangeEvents*/,
		false /* ignoreDeleteEvents*/,
	);

	watcher.onDidChange(() => updatePluginTypeDefinitions(workspaceRoot));

	watcher.onDidDelete(() => updatePluginTypeDefinitions(workspaceRoot));

	watcher.onDidCreate(() => updatePluginTypeDefinitions(workspaceRoot));

	EXTENSION_CONTEXT.subscriptions.push(watcher);

	const simulator: PluginSimulator = new PluginSimulator();

	const workspaceManager: CordovaWorkspaceManager =
		new CordovaWorkspaceManager(simulator, folder);

	ProjectsStorage.addFolder(folder, workspaceManager);

	COUNT_WORKSPACE_FOLDERS++;

	// extensionServer takes care of disposing the simulator instance
	// context.subscriptions.push(extensionServer);

	const ionicMajorVersion =
		CordovaProjectHelper.determineIonicMajorVersion(workspaceRoot);
	// In case of Ionic 1 project register completions providers for html and javascript snippets
	if (ionicMajorVersion === 1) {
		EXTENSION_CONTEXT.subscriptions.push(
			vscode.languages.registerCompletionItemProvider(
				IonicCompletionProvider.JS_DOCUMENT_SELECTOR,
				new IonicCompletionProvider(
					path.join(
						findFileInFolderHierarchy(__dirname, "snippets"),
						"ionicJs.json",
					),
				),
			),
		);

		EXTENSION_CONTEXT.subscriptions.push(
			vscode.languages.registerCompletionItemProvider(
				IonicCompletionProvider.HTML_DOCUMENT_SELECTOR,
				new IonicCompletionProvider(
					path.join(
						findFileInFolderHierarchy(__dirname, "snippets"),
						"ionicHtml.json",
					),
				),
			),
		);
	}

	// Install Ionic type definitions if necessary
	if (CordovaProjectHelper.isIonicAngularProject(workspaceRoot)) {
		let ionicTypings: string[] = [
			path.join("jquery", "jquery.d.ts"),
			path.join("cordova-ionic", "plugins", "keyboard.d.ts"),
		];

		if (ionicMajorVersion === 1) {
			ionicTypings = ionicTypings.concat([
				path.join("angularjs", "angular.d.ts"),
				path.join("ionic", "ionic.d.ts"),
			]);
		}

		TsdHelper.installTypings(
			CordovaProjectHelper.getOrCreateTypingsTargetPath(workspaceRoot),
			ionicTypings,
			workspaceRoot,
		);
	}

	const pluginTypings = getPluginTypingsJson();

	if (!pluginTypings) {
		return;
	}

	// Skip adding typings for cordova in case of Typescript or Ionic (except v1) projects
	// to avoid conflicts between typings we install and user-installed ones.
	if (
		!CordovaProjectHelper.isTypescriptProject(workspaceRoot) &&
		!(ionicMajorVersion && ionicMajorVersion > 1)
	) {
		// Install the type defintion files for Cordova
		TsdHelper.installTypings(
			CordovaProjectHelper.getOrCreateTypingsTargetPath(workspaceRoot),
			[pluginTypings[CORDOVA_TYPINGS_QUERYSTRING].typingFile],
			workspaceRoot,
		);
	}

	// Install type definition files for the currently installed plugins
	updatePluginTypeDefinitions(workspaceRoot);

	const pluginFilePath = path.join(workspaceRoot, ".vscode", "plugins.json");

	if (fs.existsSync(pluginFilePath)) {
		fs.unlinkSync(pluginFilePath);
	}

	TelemetryHelper.sendPluginsList(
		workspaceRoot,
		CordovaProjectHelper.getInstalledPlugins(workspaceRoot),
	);

	// In VSCode 0.10.10+, if the root doesn't contain jsconfig.json or tsconfig.json, intellisense won't work for files without /// typing references, so add a jsconfig.json here if necessary
	const jsconfigPath: string = path.join(workspaceRoot, JSCONFIG_FILENAME);

	const tsconfigPath: string = path.join(workspaceRoot, TSCONFIG_FILENAME);

	Promise.all([
		CordovaProjectHelper.exists(jsconfigPath),
		CordovaProjectHelper.exists(tsconfigPath),
	]).then(([jsExists, tsExists]) => {
		if (!jsExists && !tsExists) {
			fs.promises.writeFile(jsconfigPath, "{}").then(() => {
				// Any open file must be reloaded to enable intellisense on them, so inform the user
				vscode.window.showInformationMessage(
					"A 'jsconfig.json' file was created to enable IntelliSense. You may need to reload your open JS file(s).",
				);
			});
		}
	});
}

function onFolderRemoved(folder: vscode.WorkspaceFolder): void {
	Object.keys(ProjectsStorage.projectsCache).forEach((path) => {
		if (
			CordovaProjectHelper.checkPathBelongsToHierarchy(
				folder.uri.fsPath.toLowerCase(),
				path,
			)
		) {
			ProjectsStorage.delFolder(path);
		}
	});
}

function getPluginTypingsJson(): any {
	if (CordovaProjectHelper.existsSync(PLUGIN_TYPE_DEFS_PATH)) {
		return customRequire(PLUGIN_TYPE_DEFS_PATH);
	}

	console.error(
		localize(
			"CordovaPluginTypeDeclarationMappingFileIsMissing",
			"Cordova plugin type declaration mapping file 'pluginTypings.json' is missing from the extension folder.",
		),
	);

	return null;
}

function getNewTypeDefinitions(installedPlugins: string[]): string[] {
	const pluginTypings = getPluginTypingsJson();

	if (!pluginTypings) {
		return;
	}

	return installedPlugins
		.filter((pluginName) => !!pluginTypings[pluginName])
		.map((pluginName) => pluginTypings[pluginName].typingFile);
}

function addPluginTypeDefinitions(
	projectRoot: string,
	installedPlugins: string[],
	currentTypeDefs: string[],
): void {
	const pluginTypings = getPluginTypingsJson();

	if (!pluginTypings) {
		return;
	}

	const typingsToAdd = installedPlugins
		.filter((pluginName: string) => {
			if (pluginTypings[pluginName]) {
				return !currentTypeDefs.includes(
					pluginTypings[pluginName].typingFile,
				);
			}

			// If we do not know the plugin, collect it anonymously for future prioritisation
			const unknownPluginEvent =
				TelemetryHelper.createTelemetryEvent("unknownPlugin");

			unknownPluginEvent.setPiiProperty("plugin", pluginName);

			Telemetry.send(unknownPluginEvent);

			return false;
		})
		.map((pluginName: string) => {
			return pluginTypings[pluginName].typingFile;
		});

	TsdHelper.installTypings(
		CordovaProjectHelper.getOrCreateTypingsTargetPath(projectRoot),
		typingsToAdd,
		projectRoot,
	);
}

function removePluginTypeDefinitions(
	projectRoot: string,
	currentTypeDefs: string[],
	newTypeDefs: string[],
): void {
	// Find the type definition files that need to be removed
	const typeDefsToRemove = currentTypeDefs.filter(
		(typeDef: string) => !newTypeDefs.includes(typeDef),
	);

	TsdHelper.removeTypings(
		CordovaProjectHelper.getOrCreateTypingsTargetPath(projectRoot),
		typeDefsToRemove,
		projectRoot,
	);
}

function getRelativeTypeDefinitionFilePath(
	projectRoot: string,
	parentPath: string,
	typeDefinitionFile: string,
) {
	return path
		.relative(
			CordovaProjectHelper.getOrCreateTypingsTargetPath(projectRoot),
			path.resolve(parentPath, typeDefinitionFile),
		)
		.replace(/\\/g, "/");
}

function updatePluginTypeDefinitions(cordovaProjectRoot: string): void {
	// We don't need to install typings for Ionic2 and newer since it has own TS
	// wrapper around core plugins. We also won't try to manage typings
	// in typescript projects as it might break compilation due to conflicts
	// between typings we install and user-installed ones.
	const ionicMajorVersion =
		CordovaProjectHelper.determineIonicMajorVersion(cordovaProjectRoot);

	if (
		CordovaProjectHelper.isTypescriptProject(cordovaProjectRoot) ||
		ionicMajorVersion > 1
	) {
		return;
	}

	let installedPlugins: string[] =
		CordovaProjectHelper.getInstalledPlugins(cordovaProjectRoot);

	const nodeModulesDir = path.resolve(cordovaProjectRoot, "node_modules");

	if (
		semver.gte(vscode.version, "1.7.2-insider") &&
		fs.existsSync(nodeModulesDir)
	) {
		// Read installed node modules and filter out plugins that have been already installed in node_modules
		// This happens if user has used '--fetch' option to install plugin. In this case VSCode will provide
		// own intellisense for these plugins using ATA (automatic typings acquisition)
		let installedNpmModules: string[] = [];

		try {
			installedNpmModules = fs.readdirSync(nodeModulesDir);
		} catch (e) {}

		const pluginTypingsJson = getPluginTypingsJson() || {};

		installedPlugins = installedPlugins.filter((pluginId) => {
			// plugins with `forceInstallTypings` flag don't have typings on NPM yet,
			// so we still need to install these even if they present in 'node_modules'
			const forceInstallTypings =
				pluginTypingsJson[pluginId] &&
				pluginTypingsJson[pluginId].forceInstallTypings;

			return (
				forceInstallTypings || !installedNpmModules.includes(pluginId)
			);
		});
	}

	const newTypeDefs = getNewTypeDefinitions(installedPlugins);

	const cordovaPluginTypesFolder =
		CordovaProjectHelper.getCordovaPluginTypeDefsPath(cordovaProjectRoot);

	const ionicPluginTypesFolder =
		CordovaProjectHelper.getIonicPluginTypeDefsPath(cordovaProjectRoot);

	if (!CordovaProjectHelper.existsSync(cordovaPluginTypesFolder)) {
		addPluginTypeDefinitions(cordovaProjectRoot, installedPlugins, []);

		return;
	}

	let currentTypeDefs: string[] = [];

	// Now read the type definitions of Cordova plugins
	fs.readdir(
		cordovaPluginTypesFolder,
		(err: Error, cordovaTypeDefs: string[]) => {
			if (err) {
				// ignore
			}

			if (cordovaTypeDefs) {
				currentTypeDefs = cordovaTypeDefs.map((typeDef) =>
					getRelativeTypeDefinitionFilePath(
						cordovaProjectRoot,
						cordovaPluginTypesFolder,
						typeDef,
					),
				);
			}

			// Now read the type definitions of Ionic plugins
			fs.readdir(
				ionicPluginTypesFolder,
				(err: Error, ionicTypeDefs: string[]) => {
					if (err) {
						// ignore
					}

					if (ionicTypeDefs) {
						currentTypeDefs.concat(
							ionicTypeDefs.map((typeDef) =>
								getRelativeTypeDefinitionFilePath(
									cordovaProjectRoot,
									ionicPluginTypesFolder,
									typeDef,
								),
							),
						);
					}

					addPluginTypeDefinitions(
						cordovaProjectRoot,
						installedPlugins,
						currentTypeDefs,
					);

					removePluginTypeDefinitions(
						cordovaProjectRoot,
						currentTypeDefs,
						newTypeDefs,
					);
				},
			);
		},
	);
}

async function registerCordovaCommands() {
	const commands = await import("./commands/commands");

	Object.values(commands).forEach((it) => {
		EXTENSION_CONTEXT.subscriptions.push(register(it));
	});
}

function register(it) {
	return vscode.commands.registerCommand(it.codeName, it.createHandler);
}
