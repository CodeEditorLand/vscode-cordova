// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as semver from "semver";
import { QuickPickOptions, window } from "vscode";
import * as nls from "vscode-nls";

import { ErrorHelper } from "../../common/error/errorHelper";
import { InternalErrorCode } from "../../common/error/internalErrorCode";
import { ChildProcess } from "../../common/node/childProcess";
import { waitUntil } from "../../common/node/promise";
import { TargetType } from "../../debugger/cordovaDebugSession";
import {
	IDebuggableMobileTarget,
	IMobileTarget,
	MobileTarget,
} from "../mobileTarget";
import { MobileTargetManager } from "../mobileTargetManager";

nls.config({
	messageFormat: nls.MessageFormat.bundle,
	bundleFormat: nls.BundleFormat.standalone,
})();

const localize = nls.loadMessageBundle();

export interface IDebuggableIOSTarget extends IDebuggableMobileTarget {
	name: string;

	system: string;

	simIdentifier?: string;

	simDataPath?: string;
}

export class IOSTarget extends MobileTarget implements IDebuggableIOSTarget {
	protected _system: string;

	protected _name: string;

	protected _simIdentifier?: string;

	protected _simDataPath?: string;

	constructor(obj: IDebuggableIOSTarget) {
		super(obj);

		this._system = obj.system;

		this._simIdentifier = obj.simIdentifier;

		this._simDataPath = obj.simDataPath;
	}

	get system(): string {
		return this._system;
	}

	get simIdentifier(): string | undefined {
		return this._simIdentifier;
	}

	get simDataPath(): string | undefined {
		return this._simDataPath;
	}

	get name(): string {
		return this._name;
	}

	set name(value: string) {
		this._name = value;
	}
}

export class IOSTargetManager extends MobileTargetManager<IOSTarget> {
	private static readonly XCRUN_COMMAND = "xcrun";

	private static readonly SIMCTL_COMMAND = "simctl";

	private static readonly BOOT_COMMAND = "boot";

	private static readonly SIMULATORS_LIST_COMMAND = `${IOSTargetManager.XCRUN_COMMAND} ${IOSTargetManager.SIMCTL_COMMAND} list devices available --json`;

	private static readonly ALL_DEVICES_LIST_COMMAND = `${IOSTargetManager.XCRUN_COMMAND} xctrace list devices`;

	private static readonly BOOTED_STATE = "Booted";

	private static readonly SIMULATOR_START_TIMEOUT = 120;

	private static readonly ANY_SYSTEM = "AnySystem";

	private childProcess: ChildProcess = new ChildProcess();

	protected targets?: IDebuggableIOSTarget[];

	public async collectTargets(
		targetType?: TargetType.Device | TargetType.Emulator,
	): Promise<void> {
		this.targets = [];

		if (targetType === undefined || targetType === TargetType.Emulator) {
			const simulators = JSON.parse(
				await this.childProcess.execToString(
					`${IOSTargetManager.SIMULATORS_LIST_COMMAND}`,
				),
			);

			Object.keys(simulators.devices).forEach((rawSystem) => {
				const temp = rawSystem.split(".").slice(-1)[0].split("-"); // "com.apple.CoreSimulator.SimRuntime.iOS-11-4" -> ["iOS", "11", "4"]
				simulators.devices[rawSystem].forEach((device: any) => {
					// Now we support selection only for iOS system
					if (temp[0] === "iOS") {
						const system = semver
							.coerce(temp.slice(1).join("."))
							.toString(); // ["iOS", "11", "4"] -> 11.4.0
						let simIdentifier;

						try {
							const identifierPieces =
								device.deviceTypeIdentifier.split(".");

							simIdentifier =
								identifierPieces[identifierPieces.length - 1];
						} catch {}

						this.targets?.push({
							id: device.udid,
							name: device.name,
							system,
							isVirtualTarget: true,
							isOnline:
								device.state === IOSTargetManager.BOOTED_STATE,
							simIdentifier,
							simDataPath: device.dataPath,
						});
					}
				});
			});
		}

		if (targetType === undefined || targetType === TargetType.Device) {
			const allDevicesOutput = await this.childProcess.execToString(
				`${IOSTargetManager.ALL_DEVICES_LIST_COMMAND}`,
			);
			// Output example:
			// == Devices ==
			// sierra (EFDAAD01-E1A3-5F00-A357-665B501D5520)
			// My iPhone (14.4.2) (33n546e591e707bd64c718bfc1bf3e8b7c16bfc9)
			//
			// == Simulators ==
			// Apple TV (14.5) (417BDFD8-6E22-4F87-BCAA-19C241AC9548)
			// Apple TV 4K (2nd generation) (14.5) (925E6E38-0D7B-45E9-ADE0-89C20779D467)
			// ...
			const lines = allDevicesOutput
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => !!line);

			const firstDevicesIndex = lines.indexOf("== Devices ==") + 1;

			const lastDevicesIndex = lines.indexOf("== Simulators ==") - 1;

			for (let i = firstDevicesIndex; i <= lastDevicesIndex; i++) {
				const line = lines[i];

				const params = line
					.split(" ")
					.map((el) => el.trim())
					.filter((el) => !!el);
				// Add only devices with system version
				if (
					params[params.length - 1].match(/\(.+\)/) &&
					params[params.length - 2].match(/\(.+\)/)
				) {
					this.targets.push({
						id: params[params.length - 1]
							.replace(/\(|\)/g, "")
							.trim(),
						name: params.slice(0, params.length - 2).join(" "),
						system: params[params.length - 2]
							.replace(/\(|\)/g, "")
							.trim(),
						isVirtualTarget: false,
						isOnline: true,
					});
				}
			}
		}
	}

	public async selectAndPrepareTarget(
		filter?: (el: IDebuggableIOSTarget) => boolean,
	): Promise<IOSTarget | undefined> {
		const selectedTarget = await this.startSelection(filter);

		if (selectedTarget) {
			return !selectedTarget.isOnline && selectedTarget.isVirtualTarget
				? this.launchSimulator(selectedTarget)
				: new IOSTarget(selectedTarget);
		}

		return undefined;
	}

	public async isVirtualTarget(targetString: string): Promise<boolean> {
		try {
			if (targetString === TargetType.Device) {
				return false;
			} else if (targetString === TargetType.Emulator) {
				return true;
			}

			const target = (
				await this.getTargetList(
					(target) =>
						target.id === targetString ||
						target.name === targetString,
				)
			)[0];

			if (target) {
				return target.isVirtualTarget;
			}

			throw Error("There is no any target with specified target string");
		} catch {
			throw ErrorHelper.getInternalError(
				InternalErrorCode.CouldNotRecognizeTargetType,
				targetString,
			);
		}
	}

	public async getTargetList(
		filter?: (el: IMobileTarget) => boolean,
	): Promise<IDebuggableIOSTarget[]> {
		return (await super.getTargetList(filter)) as IDebuggableIOSTarget[];
	}

	protected async startSelection(
		filter?: (el: IDebuggableIOSTarget) => boolean,
	): Promise<IDebuggableIOSTarget | undefined> {
		const system = await this.selectSystem(filter);

		if (system) {
			return (await this.selectTarget(
				(el: IDebuggableIOSTarget) =>
					(filter ? filter(el) : true) &&
					(system === IOSTargetManager.ANY_SYSTEM
						? true
						: el.system === system),
			)) as IDebuggableIOSTarget | undefined;
		}

		return;
	}

	protected async selectSystem(
		filter?: (el: IDebuggableIOSTarget) => boolean,
	): Promise<string | undefined> {
		const targets = (await this.getTargetList(
			filter,
		)) as IDebuggableIOSTarget[];
		// If we select only from devices, we should not select system
		if (!targets.find((target) => target.isVirtualTarget)) {
			return IOSTargetManager.ANY_SYSTEM;
		}

		const names: Set<string> = new Set(
			targets.map((target) => `iOS ${target.system}`),
		);

		const systemsList = Array.from(names);

		let result: string | undefined = systemsList[0];

		if (systemsList.length > 1) {
			const quickPickOptions: QuickPickOptions = {
				ignoreFocusOut: true,
				canPickMany: false,
				placeHolder: localize(
					"SelectIOSSystemVersion",
					"Select system version of iOS target",
				),
			};

			result = await window.showQuickPick(systemsList, quickPickOptions);
		}

		return result?.toString().substring(4);
	}

	protected async launchSimulator(
		emulatorTarget: IDebuggableIOSTarget,
	): Promise<IOSTarget> {
		return new Promise<IOSTarget>((resolve, reject) => {
			let emulatorLaunchFailed = false;

			const emulatorProcess = this.childProcess.spawn(
				IOSTargetManager.XCRUN_COMMAND,
				[
					IOSTargetManager.SIMCTL_COMMAND,
					IOSTargetManager.BOOT_COMMAND,
					emulatorTarget.id,
				],
				{
					detached: true,
				},
				true,
			);

			emulatorProcess.spawnedProcess.unref();

			emulatorProcess.outcome.catch((err) => {
				emulatorLaunchFailed = true;

				reject(
					new Error(
						`Error while launching simulator ${emulatorTarget.name}(${emulatorTarget.id} with an exception: ${err}`,
					),
				);
			});

			const condition = async () => {
				if (emulatorLaunchFailed)
					throw ErrorHelper.getInternalError(
						InternalErrorCode.iOSSimulatorLaunchFailed,
					);

				await this.collectTargets(TargetType.Emulator);

				const onlineTarget = (await this.getTargetList()).find(
					(target) =>
						target.id === emulatorTarget.id && target.isOnline,
				);

				return onlineTarget ? true : null;
			};

			void waitUntil<boolean>(
				condition,
				1000,
				IOSTargetManager.SIMULATOR_START_TIMEOUT * 1000,
			).then(
				(isBooted) => {
					if (isBooted) {
						emulatorTarget.isOnline = true;

						this.logger.log(
							localize(
								"SimulatorLaunched",
								"Launched simulator {0}",
								emulatorTarget.name,
							),
						);

						resolve(new IOSTarget(emulatorTarget));
					} else {
						reject(
							new Error(
								`Virtual device launch finished with an exception: ${localize(
									"SimulatorStartWarning",
									"Could not start the simulator {0} within {1} seconds.",
									emulatorTarget.name,
									IOSTargetManager.SIMULATOR_START_TIMEOUT,
								)}`,
							),
						);
					}
				},
				() => {},
			);
		});
	}
}
