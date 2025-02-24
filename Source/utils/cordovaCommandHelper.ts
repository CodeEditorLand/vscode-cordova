﻿// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.
import * as child_process from "child_process";
import * as os from "os";
import { window, WorkspaceConfiguration, workspace, Uri, commands } from "vscode";
import * as nls from "vscode-nls";
import { CordovaSessionManager } from "../extension/cordovaSessionManager";
import { CordovaSessionStatus } from "../debugger/debugSessionWrapper";

nls.config({
    messageFormat: nls.MessageFormat.bundle,
    bundleFormat: nls.BundleFormat.standalone,
})();
const localize = nls.loadMessageBundle();

import { ErrorHelper } from "../common/error/errorHelper";
import { InternalErrorCode } from "../common/error/internalErrorCode";
import { TelemetryHelper } from "./telemetryHelper";
import { OutputChannelLogger } from "./log/outputChannelLogger";
import { CordovaProjectHelper } from "./cordovaProjectHelper";
import { CordovaAndroidEnvironmentHelper } from "./cordovaAndroidEnvironmentHelper";

export class CordovaCommandHelper {
    private static CORDOVA_CMD_NAME: string = os.platform() === "win32" ? "cordova.cmd" : "cordova";
    private static IONIC_CMD_NAME: string = os.platform() === "win32" ? "ionic.cmd" : "ionic";
    private static CORDOVA_TELEMETRY_EVENT_NAME: string = "cordovaCommand";
    private static IONIC_TELEMETRY_EVENT_NAME: string = "ionicCommand";
    private static CORDOVA_DISPLAY_NAME: string = "Cordova";
    private static IONIC_DISPLAY_NAME: string = "Ionic";
    private static readonly RESTART_SESSION_COMMAND: string = "workbench.action.debug.restart";

    public static executeCordovaCommand(
        projectRoot: string,
        command: string,
        useIonic: boolean = false,
    ): Promise<void> {
        let telemetryEventName: string = CordovaCommandHelper.CORDOVA_TELEMETRY_EVENT_NAME;
        let cliCommandName: string = CordovaCommandHelper.CORDOVA_CMD_NAME;
        let cliDisplayName: string = CordovaCommandHelper.CORDOVA_DISPLAY_NAME;

        if (useIonic) {
            telemetryEventName = CordovaCommandHelper.IONIC_TELEMETRY_EVENT_NAME;
            cliCommandName = CordovaCommandHelper.IONIC_CMD_NAME;
            cliDisplayName = CordovaCommandHelper.IONIC_DISPLAY_NAME;
        }

        return CordovaCommandHelper.selectPlatform(projectRoot, command, useIonic).then(
            platform => {
                TelemetryHelper.generate(telemetryEventName, generator => {
                    generator.add("command", command, false);
                    const logger = OutputChannelLogger.getMainChannel();
                    let commandToExecute;
                    if (useIonic && ["run", "prepare"].includes(command)) {
                        commandToExecute = `${cliCommandName} cordova ${command}`;
                    } else {
                        commandToExecute = `${cliCommandName} ${command}`;
                    }

                    if (platform) {
                        commandToExecute += ` ${platform}`;
                        // Workaround for dealing with new build system in XCode 10
                        // https://github.com/apache/cordova-ios/issues/407
                        if (platform === "ios") {
                            commandToExecute += " --buildFlag='-UseModernBuildSystem=0'";
                        }
                    }

                    const runArgs = CordovaCommandHelper.getRunArguments(projectRoot);
                    if (runArgs.length) {
                        commandToExecute += ` ${runArgs.join(" ")}`;
                    }

                    logger.log(
                        localize(
                            "Executing",
                            "########### EXECUTING: {0} ###########",
                            commandToExecute,
                        ),
                    );
                    const env = CordovaProjectHelper.getEnvArgument({
                        env: CordovaCommandHelper.getEnvArgs(projectRoot),
                        envFile: CordovaCommandHelper.getEnvFile(projectRoot),
                    });

                    const execution = new Promise((resolve, reject) => {
                        let process;
                        // Workaround for dealing with avdmanager in Android SDK
                        if (platform === "android") {
                            process = CordovaAndroidEnvironmentHelper.checkEnvironment(
                                projectRoot,
                                env,
                                logger,
                            )
                                .then(() => {
                                    logger.log(
                                        localize(
                                            "FinishedExecuting",
                                            "########### FINISHED EXECUTING: checkEnvironment ###########",
                                        ),
                                    );
                                    resolve({});
                                })
                                .catch(err => {
                                    logger.append(`Error: ${err.message}`);
                                    reject(err);
                                });
                        } else {
                            const [cmd, ...args] = commandToExecute.split(" ");
                            process = child_process.execFile(cmd, args, {
                                cwd: projectRoot,
                                env,
                            });
                            process.on("error", (err: any) => {
                                // ENOENT error will be thrown if no Cordova.cmd or ionic.cmd is found
                                if (err.code === "ENOENT") {
                                    window.showErrorMessage(
                                        localize(
                                            "PackageNotFoundPleaseInstall",
                                            '{0} not found, please run "npm install –g {1}" to install {2} globally', // eslint-disable-line
                                            cliDisplayName,
                                            cliDisplayName.toLowerCase(),
                                            cliDisplayName,
                                        ),
                                    );
                                }
                                reject(err);
                            });

                            process.stderr.on("data", (data: any) => {
                                logger.append(data);
                            });

                            process.stdout.on("data", (data: any) => {
                                logger.append(data);
                            });

                            process.stdout.on("close", () => {
                                // Workaround for dealing with plugman environment verification
                                if (command === "requirements") {
                                    process = child_process.execFile(
                                        "npm",
                                        ["list", "-g", "plugman", "--depth=0"],
                                        {
                                            cwd: projectRoot,
                                            env,
                                        },
                                    );

                                    process.stdout.on("data", (e: string) => {
                                        const match = e.match(/\d+\.\d+\.\d+/);
                                        logger.log(`Plugman: ${match[0]}`);
                                    });

                                    process.stdout.on("close", () => {
                                        logger.log(
                                            localize(
                                                "FinishedExecuting",
                                                "########### FINISHED EXECUTING: {0} ###########",
                                                commandToExecute,
                                            ),
                                        );
                                        resolve({});
                                    });
                                } else {
                                    logger.log(
                                        localize(
                                            "FinishedExecuting",
                                            "########### FINISHED EXECUTING: {0} ###########",
                                            commandToExecute,
                                        ),
                                    );
                                    resolve({});
                                }
                            });
                        }
                    });

                    return TelemetryHelper.determineProjectTypes(projectRoot)
                        .then(projectType =>
                            generator.add(
                                "projectType",
                                TelemetryHelper.prepareProjectTypesTelemetry(projectType),
                                false,
                            ),
                        )
                        .then(() => execution);
                });
            },
        );
    }

    public static restartCordovaDebugging(
        projectRoot: string,
        cordovaSessionManager: CordovaSessionManager,
    ): void {
        const cordovaDebugSession =
            cordovaSessionManager.getCordovaDebugSessionByProjectRoot(projectRoot);
        if (cordovaDebugSession) {
            switch (cordovaDebugSession.getStatus()) {
                case CordovaSessionStatus.Activated:
                    cordovaDebugSession.setStatus(CordovaSessionStatus.Pending);
                    commands.executeCommand(
                        CordovaCommandHelper.RESTART_SESSION_COMMAND,
                        undefined,
                        { sessionId: cordovaDebugSession.getVSCodeDebugSession().id },
                    );
                    break;
                case CordovaSessionStatus.NotActivated:
                    cordovaDebugSession.setStatus(CordovaSessionStatus.Pending);
                    commands.executeCommand(CordovaCommandHelper.RESTART_SESSION_COMMAND);
                    break;
                case CordovaSessionStatus.Pending:
                    window.showWarningMessage(
                        localize(
                            "CordovaSessionPendingWarning",
                            "A Cordova application is building now. Please wait for the build completion to start the build process again.",
                        ),
                    );
                    break;
            }
        } else {
            window.showErrorMessage(
                localize(
                    "CannotRestartDebugging",
                    'Cannot restart debugging of a Cordova application by the path "{0}". Could not find a debugging session for the application.', // eslint-disable-line
                    projectRoot,
                ),
            );
        }
    }

    /**
     * Get command line run arguments from settings.json
     */
    public static getRunArguments(fsPath: string): string[] {
        return CordovaCommandHelper.getSetting(fsPath, "runArguments") || [];
    }

    public static getCordovaExecutable(fsPath: string): string {
        return CordovaCommandHelper.getSetting(fsPath, "cordovaExecutable") || "";
    }

    public static getEnvArgs(fsPath: string): any {
        return CordovaCommandHelper.getSetting(fsPath, "env");
    }

    public static getEnvFile(fsPath: string): string {
        return CordovaCommandHelper.getSetting(fsPath, "envFile") || "";
    }

    private static getSetting(fsPath: string, configKey: string): any {
        const uri = Uri.file(fsPath);
        const workspaceConfiguration: WorkspaceConfiguration = workspace.getConfiguration(
            "cordova",
            uri,
        );
        if (workspaceConfiguration.has(configKey)) {
            return workspaceConfiguration.get(configKey);
        }
    }

    private static selectPlatform(
        projectRoot: string,
        command: string,
        useIonic: boolean,
    ): Promise<string> {
        let platforms = CordovaProjectHelper.getInstalledPlatforms(projectRoot);
        platforms = CordovaCommandHelper.filterAvailablePlatforms(platforms);

        return new Promise((resolve, reject) => {
            if (["prepare", "build", "run", "requirements"].includes(command)) {
                if (platforms.length > 1) {
                    if (!command.includes("requirements")) {
                        platforms.unshift("all");
                    }

                    // Ionic doesn't support prepare and run command without platform
                    if (useIonic && (command === "prepare" || command === "run")) {
                        platforms.shift();
                    }
                    // eslint-disable-next-line
                    return window.showQuickPick(platforms).then(platform => {
                        if (!platform) {
                            throw ErrorHelper.getInternalError(
                                InternalErrorCode.PlatformSelectionWasCancelled,
                            );
                        }

                        if (platform === "all") {
                            return resolve("");
                        }

                        return resolve(platform);
                    });
                } else if (platforms.length === 1) {
                    // eslint-disable-next-line
                    return resolve(platforms[0]);
                }
                throw ErrorHelper.getInternalError(
                    InternalErrorCode.CouldNotFindAnyPlatformInstalled,
                );
            }

            return resolve(""); // eslint-disable-line
        });
    }

    private static filterAvailablePlatforms(platforms: string[]): string[] {
        const osPlatform = os.platform();

        return platforms.filter(platform => {
            switch (platform) {
                case "ios":
                case "osx":
                    return osPlatform === "darwin";
                case "windows":
                    return osPlatform === "win32";
                default:
                    return true;
            }
        });
    }
}
