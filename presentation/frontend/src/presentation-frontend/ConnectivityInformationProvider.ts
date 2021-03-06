/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
/** @packageDocumentation
 * @module Core
 */

import { BeEvent, IDisposable } from "@bentley/bentleyjs-core";
import { InternetConnectivityStatus } from "@bentley/imodeljs-common";
import { IModelApp, NativeApp } from "@bentley/imodeljs-frontend";

/** @internal */
export interface IConnectivityInformationProvider {
  readonly status: InternetConnectivityStatus;
  readonly onInternetConnectivityChanged: BeEvent<(args: { status: InternetConnectivityStatus }) => void>;
}

/**
 * A helper that wraps connectivity-related APIs in IModelApp / NativeApp
 * to give a unified information for interested parties in presentation.
 *
 * @internal
 */
export class ConnectivityInformationProvider implements IConnectivityInformationProvider, IDisposable {

  private _currentStatus?: InternetConnectivityStatus;
  private _unsubscribeFromInternetConnectivityChangedEvent?: () => void;
  public readonly onInternetConnectivityChanged = new BeEvent<(args: { status: InternetConnectivityStatus }) => void>();

  public constructor() {
    if (IModelApp.isNativeApp) {
      this._unsubscribeFromInternetConnectivityChangedEvent = NativeApp.onInternetConnectivityChanged.addListener(this.onNativeAppInternetConnectivityChanged);
      // tslint:disable-next-line: no-floating-promises
      NativeApp.checkInternetConnectivity().then((status: InternetConnectivityStatus) => {
        if (undefined === this._currentStatus)
          this._currentStatus = status;
      });
    } else {
      this._currentStatus = InternetConnectivityStatus.Online;
    }
  }

  public dispose() {
    this._unsubscribeFromInternetConnectivityChangedEvent && this._unsubscribeFromInternetConnectivityChangedEvent();
  }

  // tslint:disable-next-line: naming-convention
  private onNativeAppInternetConnectivityChanged = (status: InternetConnectivityStatus) => {
    if (this._currentStatus === status)
      return;

    this._currentStatus = status;
    this.onInternetConnectivityChanged.raiseEvent({ status });
  }

  public get status(): InternetConnectivityStatus { return this._currentStatus ?? InternetConnectivityStatus.Offline; }
}
