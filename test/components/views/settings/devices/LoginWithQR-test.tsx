/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { cleanup, render, waitFor } from "jest-matrix-react";
import { MockedObject, mocked } from "jest-mock";
import React from "react";
import {
    MSC3906Rendezvous,
    LegacyRendezvousFailureReason,
    ClientRendezvousFailureReason,
    MSC4108SignInWithQR,
    MSC4108FailureReason,
} from "matrix-js-sdk/src/rendezvous";
import { HTTPError, LoginTokenPostResponse } from "matrix-js-sdk/src/matrix";

import LoginWithQR from "../../../../../src/components/views/auth/LoginWithQR";
import { Click, Mode, Phase } from "../../../../../src/components/views/auth/LoginWithQR-types";
import type { MatrixClient } from "matrix-js-sdk/src/matrix";

jest.mock("matrix-js-sdk/src/rendezvous");
jest.mock("matrix-js-sdk/src/rendezvous/transports");
jest.mock("matrix-js-sdk/src/rendezvous/channels");

const mockedFlow = jest.fn();

jest.mock("../../../../../src/components/views/auth/LoginWithQRFlow", () => (props: Record<string, any>) => {
    mockedFlow(props);
    return <div />;
});

function makeClient() {
    return mocked({
        getUser: jest.fn(),
        isGuest: jest.fn().mockReturnValue(false),
        isUserIgnored: jest.fn(),
        isCryptoEnabled: jest.fn(),
        getUserId: jest.fn(),
        on: jest.fn(),
        isSynapseAdministrator: jest.fn().mockResolvedValue(false),
        isRoomEncrypted: jest.fn().mockReturnValue(false),
        mxcUrlToHttp: jest.fn().mockReturnValue("mock-mxcUrlToHttp"),
        doesServerSupportUnstableFeature: jest.fn().mockReturnValue(true),
        removeListener: jest.fn(),
        requestLoginToken: jest.fn(),
        currentState: {
            on: jest.fn(),
        },
        getClientWellKnown: jest.fn().mockReturnValue({}),
        getCrypto: jest.fn().mockReturnValue({}),
        crypto: {},
    } as unknown as MatrixClient);
}

function unresolvedPromise<T>(): Promise<T> {
    return new Promise(() => {});
}

describe("<LoginWithQR />", () => {
    let client!: MockedObject<MatrixClient>;
    const defaultProps = {
        legacy: true,
        mode: Mode.Show,
        onFinished: jest.fn(),
    };
    const mockConfirmationDigits = "mock-confirmation-digits";
    const mockRendezvousCode = "mock-rendezvous-code";
    const newDeviceId = "new-device-id";

    beforeEach(() => {
        mockedFlow.mockReset();
        jest.resetAllMocks();
        client = makeClient();
    });

    afterEach(() => {
        client = makeClient();
        jest.clearAllMocks();
        jest.useRealTimers();
        cleanup();
    });

    describe("MSC3906", () => {
        const getComponent = (props: { client: MatrixClient; onFinished?: () => void }) => (
            <React.StrictMode>
                <LoginWithQR {...defaultProps} {...props} />
            </React.StrictMode>
        );

        beforeEach(() => {
            jest.spyOn(MSC3906Rendezvous.prototype, "generateCode").mockResolvedValue();
            // @ts-ignore
            // workaround for https://github.com/facebook/jest/issues/9675
            MSC3906Rendezvous.prototype.code = mockRendezvousCode;
            jest.spyOn(MSC3906Rendezvous.prototype, "cancel").mockResolvedValue();
            jest.spyOn(MSC3906Rendezvous.prototype, "startAfterShowingCode").mockResolvedValue(mockConfirmationDigits);
            jest.spyOn(MSC3906Rendezvous.prototype, "declineLoginOnExistingDevice").mockResolvedValue();
            jest.spyOn(MSC3906Rendezvous.prototype, "approveLoginOnExistingDevice").mockResolvedValue(newDeviceId);
            jest.spyOn(MSC3906Rendezvous.prototype, "verifyNewDeviceOnExistingDevice").mockResolvedValue(undefined);
            client.requestLoginToken.mockResolvedValue({
                login_token: "token",
                expires_in_ms: 1000 * 1000,
            } as LoginTokenPostResponse); // we force the type here so that it works with versions of js-sdk that don't have r1 support yet
        });

        test("no homeserver support", async () => {
            // simulate no support
            jest.spyOn(MSC3906Rendezvous.prototype, "generateCode").mockRejectedValue("");
            render(getComponent({ client }));
            await waitFor(() =>
                expect(mockedFlow).toHaveBeenLastCalledWith({
                    phase: Phase.Error,
                    failureReason: LegacyRendezvousFailureReason.HomeserverLacksSupport,
                    onClick: expect.any(Function),
                }),
            );
            const rendezvous = mocked(MSC3906Rendezvous).mock.instances[0];
            expect(rendezvous.generateCode).toHaveBeenCalled();
        });

        test("failed to connect", async () => {
            jest.spyOn(MSC3906Rendezvous.prototype, "startAfterShowingCode").mockRejectedValue("");
            render(getComponent({ client }));
            await waitFor(() =>
                expect(mockedFlow).toHaveBeenLastCalledWith({
                    phase: Phase.Error,
                    failureReason: ClientRendezvousFailureReason.Unknown,
                    onClick: expect.any(Function),
                }),
            );
            const rendezvous = mocked(MSC3906Rendezvous).mock.instances[0];
            expect(rendezvous.generateCode).toHaveBeenCalled();
            expect(rendezvous.startAfterShowingCode).toHaveBeenCalled();
        });

        test("render QR then back", async () => {
            const onFinished = jest.fn();
            jest.spyOn(MSC3906Rendezvous.prototype, "startAfterShowingCode").mockReturnValue(unresolvedPromise());
            render(getComponent({ client, onFinished }));
            const rendezvous = mocked(MSC3906Rendezvous).mock.instances[0];

            await waitFor(() =>
                expect(mockedFlow).toHaveBeenLastCalledWith(
                    expect.objectContaining({
                        phase: Phase.ShowingQR,
                    }),
                ),
            );
            // display QR code
            expect(mockedFlow).toHaveBeenLastCalledWith({
                phase: Phase.ShowingQR,
                code: mockRendezvousCode,
                onClick: expect.any(Function),
            });
            expect(rendezvous.generateCode).toHaveBeenCalled();
            expect(rendezvous.startAfterShowingCode).toHaveBeenCalled();

            // back
            const onClick = mockedFlow.mock.calls[0][0].onClick;
            await onClick(Click.Back);
            expect(onFinished).toHaveBeenCalledWith(false);
            expect(rendezvous.cancel).toHaveBeenCalledWith(LegacyRendezvousFailureReason.UserCancelled);
        });

        test("render QR then decline", async () => {
            const onFinished = jest.fn();
            render(getComponent({ client, onFinished }));
            const rendezvous = mocked(MSC3906Rendezvous).mock.instances[0];

            await waitFor(() =>
                expect(mockedFlow).toHaveBeenLastCalledWith(
                    expect.objectContaining({
                        phase: Phase.LegacyConnected,
                    }),
                ),
            );
            expect(mockedFlow).toHaveBeenLastCalledWith({
                phase: Phase.LegacyConnected,
                confirmationDigits: mockConfirmationDigits,
                onClick: expect.any(Function),
            });

            // decline
            const onClick = mockedFlow.mock.calls[0][0].onClick;
            await onClick(Click.Decline);
            expect(onFinished).toHaveBeenCalledWith(false);

            expect(rendezvous.generateCode).toHaveBeenCalled();
            expect(rendezvous.startAfterShowingCode).toHaveBeenCalled();
            expect(rendezvous.declineLoginOnExistingDevice).toHaveBeenCalled();
        });

        test("approve - no crypto", async () => {
            (client as any).crypto = undefined;
            (client as any).getCrypto = () => undefined;
            const onFinished = jest.fn();
            render(getComponent({ client, onFinished }));
            const rendezvous = mocked(MSC3906Rendezvous).mock.instances[0];

            await waitFor(() =>
                expect(mockedFlow).toHaveBeenLastCalledWith(
                    expect.objectContaining({
                        phase: Phase.LegacyConnected,
                    }),
                ),
            );
            expect(mockedFlow).toHaveBeenLastCalledWith({
                phase: Phase.LegacyConnected,
                confirmationDigits: mockConfirmationDigits,
                onClick: expect.any(Function),
            });
            expect(rendezvous.generateCode).toHaveBeenCalled();
            expect(rendezvous.startAfterShowingCode).toHaveBeenCalled();

            // approve
            const onClick = mockedFlow.mock.calls[0][0].onClick;
            await onClick(Click.Approve);

            await waitFor(() =>
                expect(mockedFlow).toHaveBeenLastCalledWith(
                    expect.objectContaining({
                        phase: Phase.WaitingForDevice,
                    }),
                ),
            );

            expect(rendezvous.approveLoginOnExistingDevice).toHaveBeenCalledWith("token");

            expect(onFinished).toHaveBeenCalledWith(true);
        });

        test("approve + verifying", async () => {
            const onFinished = jest.fn();
            jest.spyOn(MSC3906Rendezvous.prototype, "verifyNewDeviceOnExistingDevice").mockImplementation(() =>
                unresolvedPromise(),
            );
            render(getComponent({ client, onFinished }));
            const rendezvous = mocked(MSC3906Rendezvous).mock.instances[0];

            await waitFor(() =>
                expect(mockedFlow).toHaveBeenLastCalledWith(
                    expect.objectContaining({
                        phase: Phase.LegacyConnected,
                    }),
                ),
            );
            expect(mockedFlow).toHaveBeenLastCalledWith({
                phase: Phase.LegacyConnected,
                confirmationDigits: mockConfirmationDigits,
                onClick: expect.any(Function),
            });
            expect(rendezvous.generateCode).toHaveBeenCalled();
            expect(rendezvous.startAfterShowingCode).toHaveBeenCalled();

            // approve
            const onClick = mockedFlow.mock.calls[0][0].onClick;
            onClick(Click.Approve);

            await waitFor(() =>
                expect(mockedFlow).toHaveBeenLastCalledWith(
                    expect.objectContaining({
                        phase: Phase.Verifying,
                    }),
                ),
            );

            expect(rendezvous.approveLoginOnExistingDevice).toHaveBeenCalledWith("token");
            expect(rendezvous.verifyNewDeviceOnExistingDevice).toHaveBeenCalled();
            // expect(onFinished).toHaveBeenCalledWith(true);
        });

        test("approve + verify", async () => {
            const onFinished = jest.fn();
            render(getComponent({ client, onFinished }));
            const rendezvous = mocked(MSC3906Rendezvous).mock.instances[0];

            await waitFor(() =>
                expect(mockedFlow).toHaveBeenLastCalledWith(
                    expect.objectContaining({
                        phase: Phase.LegacyConnected,
                    }),
                ),
            );
            expect(mockedFlow).toHaveBeenLastCalledWith({
                phase: Phase.LegacyConnected,
                confirmationDigits: mockConfirmationDigits,
                onClick: expect.any(Function),
            });
            expect(rendezvous.generateCode).toHaveBeenCalled();
            expect(rendezvous.startAfterShowingCode).toHaveBeenCalled();

            // approve
            const onClick = mockedFlow.mock.calls[0][0].onClick;
            await onClick(Click.Approve);
            expect(rendezvous.approveLoginOnExistingDevice).toHaveBeenCalledWith("token");
            expect(rendezvous.verifyNewDeviceOnExistingDevice).toHaveBeenCalled();
            expect(rendezvous.close).toHaveBeenCalled();
            expect(onFinished).toHaveBeenCalledWith(true);
        });

        test("approve - rate limited", async () => {
            mocked(client.requestLoginToken).mockRejectedValue(new HTTPError("rate limit reached", 429));
            const onFinished = jest.fn();
            render(getComponent({ client, onFinished }));
            const rendezvous = mocked(MSC3906Rendezvous).mock.instances[0];

            await waitFor(() =>
                expect(mockedFlow).toHaveBeenLastCalledWith(
                    expect.objectContaining({
                        phase: Phase.LegacyConnected,
                    }),
                ),
            );
            expect(mockedFlow).toHaveBeenLastCalledWith({
                phase: Phase.LegacyConnected,
                confirmationDigits: mockConfirmationDigits,
                onClick: expect.any(Function),
            });
            expect(rendezvous.generateCode).toHaveBeenCalled();
            expect(rendezvous.startAfterShowingCode).toHaveBeenCalled();

            // approve
            const onClick = mockedFlow.mock.calls[0][0].onClick;
            await onClick(Click.Approve);

            // the 429 error should be handled and mapped
            await waitFor(() =>
                expect(mockedFlow).toHaveBeenLastCalledWith(
                    expect.objectContaining({
                        phase: Phase.Error,
                        failureReason: "rate_limited",
                    }),
                ),
            );
        });
    });

    describe("MSC4108", () => {
        const getComponent = (props: { client: MatrixClient; onFinished?: () => void }) => (
            <React.StrictMode>
                <LoginWithQR {...defaultProps} {...props} legacy={false} />
            </React.StrictMode>
        );

        test("render QR then back", async () => {
            const onFinished = jest.fn();
            jest.spyOn(MSC4108SignInWithQR.prototype, "negotiateProtocols").mockReturnValue(unresolvedPromise());
            render(getComponent({ client, onFinished }));

            await waitFor(() =>
                expect(mockedFlow).toHaveBeenLastCalledWith({
                    phase: Phase.ShowingQR,
                    onClick: expect.any(Function),
                }),
            );

            const rendezvous = mocked(MSC4108SignInWithQR).mock.instances[0];
            expect(rendezvous.generateCode).toHaveBeenCalled();
            expect(rendezvous.negotiateProtocols).toHaveBeenCalled();

            // back
            const onClick = mockedFlow.mock.calls[0][0].onClick;
            await onClick(Click.Back);
            expect(onFinished).toHaveBeenCalledWith(false);
            expect(rendezvous.cancel).toHaveBeenCalledWith(LegacyRendezvousFailureReason.UserCancelled);
        });

        test("failed to connect", async () => {
            render(getComponent({ client }));
            jest.spyOn(MSC4108SignInWithQR.prototype, "negotiateProtocols").mockResolvedValue({});
            jest.spyOn(MSC4108SignInWithQR.prototype, "deviceAuthorizationGrant").mockRejectedValue(
                new HTTPError("Internal Server Error", 500),
            );
            const fn = jest.spyOn(MSC4108SignInWithQR.prototype, "cancel");
            await waitFor(() => expect(fn).toHaveBeenLastCalledWith(ClientRendezvousFailureReason.Unknown));
        });

        test("reciprocates login", async () => {
            jest.spyOn(global.window, "open");

            render(getComponent({ client }));
            jest.spyOn(MSC4108SignInWithQR.prototype, "negotiateProtocols").mockResolvedValue({});
            jest.spyOn(MSC4108SignInWithQR.prototype, "deviceAuthorizationGrant").mockResolvedValue({
                verificationUri: "mock-verification-uri",
            });

            await waitFor(() =>
                expect(mockedFlow).toHaveBeenLastCalledWith({
                    phase: Phase.OutOfBandConfirmation,
                    onClick: expect.any(Function),
                }),
            );

            const onClick = mockedFlow.mock.calls[0][0].onClick;
            await onClick(Click.Approve);

            await waitFor(() =>
                expect(mockedFlow).toHaveBeenLastCalledWith({
                    phase: Phase.WaitingForDevice,
                    onClick: expect.any(Function),
                }),
            );
            expect(global.window.open).toHaveBeenCalledWith("mock-verification-uri", "_blank");
        });

        test("handles errors during reciprocation", async () => {
            render(getComponent({ client }));
            jest.spyOn(MSC4108SignInWithQR.prototype, "negotiateProtocols").mockResolvedValue({});
            jest.spyOn(MSC4108SignInWithQR.prototype, "deviceAuthorizationGrant").mockResolvedValue({});
            await waitFor(() =>
                expect(mockedFlow).toHaveBeenLastCalledWith({
                    phase: Phase.OutOfBandConfirmation,
                    onClick: expect.any(Function),
                }),
            );

            jest.spyOn(MSC4108SignInWithQR.prototype, "shareSecrets").mockRejectedValue(
                new HTTPError("Internal Server Error", 500),
            );
            const onClick = mockedFlow.mock.calls[0][0].onClick;
            await onClick(Click.Approve);

            await waitFor(() =>
                expect(mockedFlow).toHaveBeenLastCalledWith(
                    expect.objectContaining({
                        phase: Phase.Error,
                        failureReason: ClientRendezvousFailureReason.Unknown,
                    }),
                ),
            );
        });

        test("handles user cancelling during reciprocation", async () => {
            render(getComponent({ client }));
            jest.spyOn(MSC4108SignInWithQR.prototype, "negotiateProtocols").mockResolvedValue({});
            jest.spyOn(MSC4108SignInWithQR.prototype, "deviceAuthorizationGrant").mockResolvedValue({});
            jest.spyOn(MSC4108SignInWithQR.prototype, "deviceAuthorizationGrant").mockResolvedValue({});
            await waitFor(() =>
                expect(mockedFlow).toHaveBeenLastCalledWith({
                    phase: Phase.OutOfBandConfirmation,
                    onClick: expect.any(Function),
                }),
            );

            jest.spyOn(MSC4108SignInWithQR.prototype, "cancel").mockResolvedValue();
            const onClick = mockedFlow.mock.calls[0][0].onClick;
            await onClick(Click.Cancel);

            const rendezvous = mocked(MSC4108SignInWithQR).mock.instances[0];
            expect(rendezvous.cancel).toHaveBeenCalledWith(MSC4108FailureReason.UserCancelled);
        });
    });
});
