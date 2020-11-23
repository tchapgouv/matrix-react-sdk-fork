/*
Copyright 2015, 2016, 2017, 2018, 2019 New Vector Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import React, {ComponentProps, ReactNode} from 'react';

import {_t, _td} from '../../../languageHandler';
import * as sdk from '../../../index';
import Login from '../../../Login';
import SdkConfig from '../../../SdkConfig';
import { messageForResourceLimitError } from '../../../utils/ErrorUtils';
import AutoDiscoveryUtils, {ValidatedServerConfig} from "../../../utils/AutoDiscoveryUtils";
import classNames from "classnames";
import AuthPage from "../../views/auth/AuthPage";
import SSOButton from "../../views/elements/SSOButton";
import PlatformPeg from '../../../PlatformPeg';
import SettingsStore from "../../../settings/SettingsStore";
import {UIFeature} from "../../../settings/UIFeature";
import CountlyAnalytics from "../../../CountlyAnalytics";
import {IMatrixClientCreds} from "../../../MatrixClientPeg";
import ServerConfig from "../../views/auth/ServerConfig";
import PasswordLogin from "../../views/auth/PasswordLogin";
import SignInToText from "../../views/auth/SignInToText";
import InlineSpinner from "../../views/elements/InlineSpinner";
import Spinner from "../../views/elements/Spinner";

// Enable phases for login
const PHASES_ENABLED = true;

// These are used in several places, and come from the js-sdk's autodiscovery
// stuff. We define them here so that they'll be picked up by i18n.
_td("Invalid homeserver discovery response");
_td("Failed to get autodiscovery configuration from server");
_td("Invalid base_url for m.homeserver");
_td("Homeserver URL does not appear to be a valid Matrix homeserver");
_td("Invalid identity server discovery response");
_td("Invalid base_url for m.identity_server");
_td("Identity server URL does not appear to be a valid identity server");
_td("General failure");

interface IProps {
    serverConfig: ValidatedServerConfig;
    // If true, the component will consider itself busy.
    busy?: boolean;
    isSyncing?: boolean;
    // Secondary HS which we try to log into if the user is using
    // the default HS but login fails. Useful for migrating to a
    // different homeserver without confusing users.
    fallbackHsUrl?: string;
    defaultDeviceDisplayName?: string;
    fragmentAfterLogin?: string;

    // Called when the user has logged in. Params:
    // - The object returned by the login API
    // - The user's password, if applicable, (may be cached in memory for a
    //   short time so the user is not required to re-enter their password
    //   for operations like uploading cross-signing keys).
    onLoggedIn(data: IMatrixClientCreds, password: string): void;

    // login shouldn't know or care how registration, password recovery, etc is done.
    onRegisterClick(): void;
    onForgotPasswordClick?(): void;
    onServerConfigChange(config: ValidatedServerConfig): void;
}

enum Phase {
    // Show controls to configure server details
    ServerDetails,
    // Show the appropriate login flow(s) for the server
    Login,
}

interface IState {
    busy: boolean;
    busyLoggingIn?: boolean;
    errorText?: ReactNode;
    loginIncorrect: boolean;
    // can we attempt to log in or are there validation errors?
    canTryLogin: boolean;

    // used for preserving form values when changing homeserver
    username: string;
    phoneCountry?: string;
    phoneNumber: string;

    // Phase of the overall login dialog.
    phase: Phase;
    // The current login flow, such as password, SSO, etc.
    // we need to load the flows from the server
    currentFlow?: string;

    // We perform liveliness checks later, but for now suppress the errors.
    // We also track the server dead errors independently of the regular errors so
    // that we can render it differently, and override any other error the user may
    // be seeing.
    serverIsAlive: boolean;
    serverErrorIsFatal: boolean;
    serverDeadError: string;
}

/*
 * A wire component which glues together login UI components and Login logic
 */
export default class LoginComponent extends React.Component<IProps, IState> {
    private unmounted = false;
    private loginLogic: Login;
    private readonly stepRendererMap: Record<string, () => ReactNode>;

    constructor(props) {
        super(props);

        this.state = {
            busy: false,
            busyLoggingIn: null,
            errorText: null,
            loginIncorrect: false,
            canTryLogin: true,
            username: "",
            phoneCountry: null,
            phoneNumber: "",
            phase: Phase.Login,
            currentFlow: null,
            serverIsAlive: true,
            serverErrorIsFatal: false,
            serverDeadError: "",
        };

        // map from login step type to a function which will render a control
        // letting you do that login type
        this.stepRendererMap = {
            'm.login.password': this.renderPasswordStep,

            // CAS and SSO are the same thing, modulo the url we link to
            'm.login.cas': () => this.renderSsoStep("cas"),
            'm.login.sso': () => this.renderSsoStep("sso"),
        };

        CountlyAnalytics.instance.track("onboarding_login_begin");
    }

    // TODO: [REACT-WARNING] Replace with appropriate lifecycle event
    // eslint-disable-next-line camelcase
    UNSAFE_componentWillMount() {
        this.initLoginLogic(this.props.serverConfig);
    }

    componentWillUnmount() {
        this.unmounted = true;
    }

    // TODO: [REACT-WARNING] Replace with appropriate lifecycle event
    // eslint-disable-next-line camelcase
    UNSAFE_componentWillReceiveProps(newProps) {
        if (newProps.serverConfig.hsUrl === this.props.serverConfig.hsUrl &&
            newProps.serverConfig.isUrl === this.props.serverConfig.isUrl) return;

        // Ensure that we end up actually logging in to the right place
        this.initLoginLogic(newProps.serverConfig);
    }

    isBusy = () => this.state.busy || this.props.busy;

    onPasswordLogin = async (username, phoneCountry, phoneNumber, password) => {
        if (!this.state.serverIsAlive) {
            this.setState({busy: true});
            // Do a quick liveliness check on the URLs
            let aliveAgain = true;
            try {
                await AutoDiscoveryUtils.validateServerConfigWithStaticUrls(
                    this.props.serverConfig.hsUrl,
                    this.props.serverConfig.isUrl,
                );
                this.setState({serverIsAlive: true, errorText: ""});
            } catch (e) {
                const componentState = AutoDiscoveryUtils.authComponentStateForError(e);
                this.setState({
                    busy: false,
                    busyLoggingIn: false,
                    ...componentState,
                });
                aliveAgain = !componentState.serverErrorIsFatal;
            }

            // Prevent people from submitting their password when something isn't right.
            if (!aliveAgain) {
                return;
            }
        }

        this.setState({
            busy: true,
            busyLoggingIn: true,
            errorText: null,
            loginIncorrect: false,
        });

        this.loginLogic.loginViaPassword(
            username, phoneCountry, phoneNumber, password,
        ).then((data) => {
            this.setState({serverIsAlive: true}); // it must be, we logged in.
            this.props.onLoggedIn(data, password);
        }, (error) => {
            if (this.unmounted) {
                return;
            }
            let errorText;

            // Some error strings only apply for logging in
            const usingEmail = username.indexOf("@") > 0;
            if (error.httpStatus === 400 && usingEmail) {
                errorText = _t('This homeserver does not support login using email address.');
            } else if (error.errcode === 'M_RESOURCE_LIMIT_EXCEEDED') {
                const errorTop = messageForResourceLimitError(
                    error.data.limit_type,
                    error.data.admin_contact,
                    {
                        'monthly_active_user': _td(
                            "This homeserver has hit its Monthly Active User limit.",
                        ),
                        '': _td(
                            "This homeserver has exceeded one of its resource limits.",
                        ),
                    },
                );
                const errorDetail = messageForResourceLimitError(
                    error.data.limit_type,
                    error.data.admin_contact,
                    {
                        '': _td("Please <a>contact your service administrator</a> to continue using this service."),
                    },
                );
                errorText = (
                    <div>
                        <div>{errorTop}</div>
                        <div className="mx_Login_smallError">{errorDetail}</div>
                    </div>
                );
            } else if (error.httpStatus === 401 || error.httpStatus === 403) {
                if (error.errcode === 'M_USER_DEACTIVATED') {
                    errorText = _t('This account has been deactivated.');
                } else if (SdkConfig.get()['disable_custom_urls']) {
                    errorText = (
                        <div>
                            <div>{ _t('Incorrect username and/or password.') }</div>
                            <div className="mx_Login_smallError">
                                {_t(
                                    'Please note you are logging into the %(hs)s server, not matrix.org.',
                                    {hs: this.props.serverConfig.hsName},
                                )}
                            </div>
                        </div>
                    );
                } else {
                    errorText = _t('Incorrect username and/or password.');
                }
            } else {
                // other errors, not specific to doing a password login
                errorText = this.errorTextFromError(error);
            }

            this.setState({
                busy: false,
                busyLoggingIn: false,
                errorText: errorText,
                // 401 would be the sensible status code for 'incorrect password'
                // but the login API gives a 403 https://matrix.org/jira/browse/SYN-744
                // mentions this (although the bug is for UI auth which is not this)
                // We treat both as an incorrect password
                loginIncorrect: error.httpStatus === 401 || error.httpStatus === 403,
            });
        });
    };

    onUsernameChanged = username => {
        this.setState({ username: username });
    };

    onUsernameBlur = async username => {
        const doWellknownLookup = username[0] === "@";
        this.setState({
            username: username,
            busy: doWellknownLookup,
            errorText: null,
            canTryLogin: true,
        });
        if (doWellknownLookup) {
            const serverName = username.split(':').slice(1).join(':');
            try {
                const result = await AutoDiscoveryUtils.validateServerName(serverName);
                this.props.onServerConfigChange(result);
                // We'd like to rely on new props coming in via `onServerConfigChange`
                // so that we know the servers have definitely updated before clearing
                // the busy state. In the case of a full MXID that resolves to the same
                // HS as Element's default HS though, there may not be any server change.
                // To avoid this trap, we clear busy here. For cases where the server
                // actually has changed, `initLoginLogic` will be called and manages
                // busy state for its own liveness check.
                this.setState({
                    busy: false,
                });
            } catch (e) {
                console.error("Problem parsing URL or unhandled error doing .well-known discovery:", e);

                let message = _t("Failed to perform homeserver discovery");
                if (e.translatedMessage) {
                    message = e.translatedMessage;
                }

                let errorText: ReactNode = message;
                let discoveryState = {};
                if (AutoDiscoveryUtils.isLivelinessError(e)) {
                    errorText = this.state.errorText;
                    discoveryState = AutoDiscoveryUtils.authComponentStateForError(e);
                }

                this.setState({
                    busy: false,
                    errorText,
                    ...discoveryState,
                });
            }
        }
    };

    onPhoneCountryChanged = phoneCountry => {
        this.setState({ phoneCountry: phoneCountry });
    };

    onPhoneNumberChanged = phoneNumber => {
        this.setState({
            phoneNumber: phoneNumber,
        });
    };

    onRegisterClick = ev => {
        ev.preventDefault();
        ev.stopPropagation();
        this.props.onRegisterClick();
    };

    onTryRegisterClick = ev => {
        const step = this.getCurrentFlowStep();
        if (step === 'm.login.sso' || step === 'm.login.cas') {
            // If we're showing SSO it means that registration is also probably disabled,
            // so intercept the click and instead pretend the user clicked 'Sign in with SSO'.
            ev.preventDefault();
            ev.stopPropagation();
            const ssoKind = step === 'm.login.sso' ? 'sso' : 'cas';
            PlatformPeg.get().startSingleSignOn(this.loginLogic.createTemporaryClient(), ssoKind,
                this.props.fragmentAfterLogin);
        } else {
            // Don't intercept - just go through to the register page
            this.onRegisterClick(ev);
        }
    };

    private onServerDetailsNextPhaseClick = () => {
        this.setState({
            phase: Phase.Login,
        });
    };

    private onEditServerDetailsClick = ev => {
        ev.preventDefault();
        ev.stopPropagation();
        this.setState({
            phase: Phase.ServerDetails,
        });
    };

    private async initLoginLogic({hsUrl, isUrl}: ValidatedServerConfig) {
        let isDefaultServer = false;
        if (this.props.serverConfig.isDefault
            && hsUrl === this.props.serverConfig.hsUrl
            && isUrl === this.props.serverConfig.isUrl) {
            isDefaultServer = true;
        }

        const fallbackHsUrl = isDefaultServer ? this.props.fallbackHsUrl : null;

        const loginLogic = new Login(hsUrl, isUrl, fallbackHsUrl, {
            defaultDeviceDisplayName: this.props.defaultDeviceDisplayName,
        });
        this.loginLogic = loginLogic;

        this.setState({
            busy: true,
            currentFlow: null, // reset flow
            loginIncorrect: false,
        });

        // Do a quick liveliness check on the URLs
        try {
            const { warning } =
                await AutoDiscoveryUtils.validateServerConfigWithStaticUrls(hsUrl, isUrl);
            if (warning) {
                this.setState({
                    ...AutoDiscoveryUtils.authComponentStateForError(warning),
                    errorText: "",
                });
            } else {
                this.setState({
                    serverIsAlive: true,
                    errorText: "",
                });
            }
        } catch (e) {
            this.setState({
                busy: false,
                ...AutoDiscoveryUtils.authComponentStateForError(e),
            });
            if (this.state.serverErrorIsFatal) {
                // Server is dead: show server details prompt instead
                this.setState({
                    phase: Phase.ServerDetails,
                });
                return;
            }
        }

        loginLogic.getFlows().then((flows) => {
            // look for a flow where we understand all of the steps.
            for (let i = 0; i < flows.length; i++ ) {
                if (!this.isSupportedFlow(flows[i])) {
                    continue;
                }

                // we just pick the first flow where we support all the
                // steps. (we don't have a UI for multiple logins so let's skip
                // that for now).
                loginLogic.chooseFlow(i);
                this.setState({
                    currentFlow: this.getCurrentFlowStep(),
                });
                return;
            }
            // we got to the end of the list without finding a suitable
            // flow.
            this.setState({
                errorText: _t(
                    "This homeserver doesn't offer any login flows which are " +
                        "supported by this client.",
                ),
            });
        }, (err) => {
            this.setState({
                errorText: this.errorTextFromError(err),
                loginIncorrect: false,
                canTryLogin: false,
            });
        }).finally(() => {
            this.setState({
                busy: false,
            });
        });
    }

    private isSupportedFlow(flow) {
        // technically the flow can have multiple steps, but no one does this
        // for login and loginLogic doesn't support it so we can ignore it.
        if (!this.stepRendererMap[flow.type]) {
            console.log("Skipping flow", flow, "due to unsupported login type", flow.type);
            return false;
        }
        return true;
    }

    private getCurrentFlowStep() {
        return this.loginLogic ? this.loginLogic.getCurrentFlowStep() : null;
    }

    private errorTextFromError(err) {
        let errCode = err.errcode;
        if (!errCode && err.httpStatus) {
            errCode = "HTTP " + err.httpStatus;
        }

        let errorText: ReactNode = _t("Error: Problem communicating with the given homeserver.") +
            (errCode ? " (" + errCode + ")" : "");

        if (err.cors === 'rejected') {
            if (window.location.protocol === 'https:' &&
                (this.props.serverConfig.hsUrl.startsWith("http:") ||
                 !this.props.serverConfig.hsUrl.startsWith("http"))
            ) {
                errorText = <span>
                    { _t("Can't connect to homeserver via HTTP when an HTTPS URL is in your browser bar. " +
                        "Either use HTTPS or <a>enable unsafe scripts</a>.", {},
                    {
                        'a': (sub) => {
                            return <a target="_blank" rel="noreferrer noopener"
                                href="https://www.google.com/search?&q=enable%20unsafe%20scripts"
                            >
                                { sub }
                            </a>;
                        },
                    }) }
                </span>;
            } else {
                errorText = <span>
                    { _t("Can't connect to homeserver - please check your connectivity, ensure your " +
                        "<a>homeserver's SSL certificate</a> is trusted, and that a browser extension " +
                        "is not blocking requests.", {},
                    {
                        'a': (sub) =>
                            <a target="_blank" rel="noreferrer noopener" href={this.props.serverConfig.hsUrl}>
                                { sub }
                            </a>,
                    }) }
                </span>;
            }
        }

        return errorText;
    }

    private renderServerComponent() {
        if (SdkConfig.get()['disable_custom_urls']) {
            return null;
        }

        if (PHASES_ENABLED && this.state.phase !== Phase.ServerDetails) {
            return null;
        }

        const serverDetailsProps: ComponentProps<typeof ServerConfig> = {};
        if (PHASES_ENABLED) {
            serverDetailsProps.onAfterSubmit = this.onServerDetailsNextPhaseClick;
            serverDetailsProps.submitText = _t("Next");
            serverDetailsProps.submitClass = "mx_Login_submit";
        }

        return <ServerConfig
            serverConfig={this.props.serverConfig}
            onServerConfigChange={this.props.onServerConfigChange}
            delayTimeMs={250}
            {...serverDetailsProps}
        />;
    }

    private renderLoginComponentForStep() {
        if (PHASES_ENABLED && this.state.phase !== Phase.Login) {
            return null;
        }

        const step = this.state.currentFlow;

        if (!step) {
            return null;
        }

        const stepRenderer = this.stepRendererMap[step];

        if (stepRenderer) {
            return stepRenderer();
        }

        return null;
    }

    private renderPasswordStep = () => {
        let onEditServerDetailsClick = null;
        // If custom URLs are allowed, wire up the server details edit link.
        if (PHASES_ENABLED && !SdkConfig.get()['disable_custom_urls']) {
            onEditServerDetailsClick = this.onEditServerDetailsClick;
        }

        return (
            <PasswordLogin
                onSubmit={this.onPasswordLogin}
                onEditServerDetailsClick={onEditServerDetailsClick}
                username={this.state.username}
                phoneCountry={this.state.phoneCountry}
                phoneNumber={this.state.phoneNumber}
                onUsernameChanged={this.onUsernameChanged}
                onUsernameBlur={this.onUsernameBlur}
                onPhoneCountryChanged={this.onPhoneCountryChanged}
                onPhoneNumberChanged={this.onPhoneNumberChanged}
                onForgotPasswordClick={this.props.onForgotPasswordClick}
                loginIncorrect={this.state.loginIncorrect}
                serverConfig={this.props.serverConfig}
                disableSubmit={this.isBusy()}
                busy={this.props.isSyncing || this.state.busyLoggingIn}
            />
        );
    };

    private renderSsoStep = loginType => {
        let onEditServerDetailsClick = null;
        // If custom URLs are allowed, wire up the server details edit link.
        if (PHASES_ENABLED && !SdkConfig.get()['disable_custom_urls']) {
            onEditServerDetailsClick = this.onEditServerDetailsClick;
        }
        // XXX: This link does *not* have a target="_blank" because single sign-on relies on
        // redirecting the user back to a URI once they're logged in. On the web, this means
        // we use the same window and redirect back to Element. On Electron, this actually
        // opens the SSO page in the Electron app itself due to
        // https://github.com/electron/electron/issues/8841 and so happens to work.
        // If this bug gets fixed, it will break SSO since it will open the SSO page in the
        // user's browser, let them log into their SSO provider, then redirect their browser
        // to vector://vector which, of course, will not work.
        return (
            <div>
                <SignInToText serverConfig={this.props.serverConfig}
                    onEditServerDetailsClick={onEditServerDetailsClick} />

                <SSOButton
                    className="mx_Login_sso_link mx_Login_submit"
                    matrixClient={this.loginLogic.createTemporaryClient()}
                    loginType={loginType}
                    fragmentAfterLogin={this.props.fragmentAfterLogin}
                />
            </div>
        );
    };

    render() {
        const AuthHeader = sdk.getComponent("auth.AuthHeader");
        const AuthBody = sdk.getComponent("auth.AuthBody");
        const loader = this.isBusy() && !this.state.busyLoggingIn ?
            <div className="mx_Login_loader"><Spinner /></div> : null;

        const errorText = this.state.errorText;

        let errorTextSection;
        if (errorText) {
            errorTextSection = (
                <div className="mx_Login_error">
                    { errorText }
                </div>
            );
        }

        let serverDeadSection;
        if (!this.state.serverIsAlive) {
            const classes = classNames({
                "mx_Login_error": true,
                "mx_Login_serverError": true,
                "mx_Login_serverErrorNonFatal": !this.state.serverErrorIsFatal,
            });
            serverDeadSection = (
                <div className={classes}>
                    {this.state.serverDeadError}
                </div>
            );
        }

        let footer;
        if (this.props.isSyncing || this.state.busyLoggingIn) {
            footer = <div className="mx_AuthBody_paddedFooter">
                <div className="mx_AuthBody_paddedFooter_title">
                    <InlineSpinner w={20} h={20} />
                    { this.props.isSyncing ? _t("Syncing...") : _t("Signing In...") }
                </div>
                { this.props.isSyncing && <div className="mx_AuthBody_paddedFooter_subtitle">
                    {_t("If you've joined lots of rooms, this might take a while")}
                </div> }
            </div>;
        } else if (SettingsStore.getValue(UIFeature.Registration)) {
            footer = (
                <span className="mx_AuthBody_changeFlow">
                    {_t("New? <a>Create account</a>", {}, {
                        a: sub => <a onClick={this.onTryRegisterClick} href="#">{ sub }</a>,
                    })}
                </span>
            );
        }

        return (
            <AuthPage>
                <AuthHeader disableLanguageSelector={this.props.isSyncing || this.state.busyLoggingIn} />
                <AuthBody>
                    <h2>
                        {_t('Sign in')}
                        {loader}
                    </h2>
                    { errorTextSection }
                    { serverDeadSection }
                    { this.renderServerComponent() }
                    { this.renderLoginComponentForStep() }
                    { footer }
                </AuthBody>
            </AuthPage>
        );
    }
}
