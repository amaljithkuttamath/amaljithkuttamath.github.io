# Use a ChatGPT subscription in Chitti

Chitti can use models available to your ChatGPT account through OpenAI’s
[official open-source sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).
This is separate from the **OpenAI API** provider and does not require an API key.
Your plan, workspace permissions and app limits determine availability.

## Run the local companion

Install Node.js 22 or newer, then run:

```sh
git clone https://github.com/amaljithkuttamath/amaljithkuttamath.github.io.git
cd amaljithkuttamath.github.io
npm install
npm run chitti:connect
```

Keep that terminal running. Open [Chitti](https://amaljithkuttamath.github.io/apps/chitti/),
then **Settings → Provider → ChatGPT subscription**. Click **Continue with ChatGPT**,
follow the ChatGPT link and authorize Chitti. Return and click **Check connection**,
choose an available model, and **Apply settings**. Allow local network access if
prompted by your browser. Browsers that block public websites from reaching
loopback can use the local interface: run `npm run dev -- --host 127.0.0.1 --port 4322`
in a second terminal and open `http://127.0.0.1:4322/apps/chitti/`.

Account selection and model choice last until the page reloads. Reopen settings
to select a saved account. Separate registrations are kept for each account or
workspace; **Add account** starts a new registration. Existing analysis sessions
keep their selected account and model. Reconnect that account without starting a
new analysis, or start a new analysis to switch accounts/models.

## Credentials and requests

The companion listens only on `127.0.0.1:4319`. It accepts the production website
and local development origins on ports 4322/4323, with exact Host/Origin checks
and a preflighted custom request header. It does not expose arbitrary proxy routes
or run tools. Chitti’s data fetching, computation and charts remain in the browser.

OAuth uses PKCE, state and nonce validation, and signature/issuer/audience/expiry
checks on ID tokens. The companion saves separate account registrations in
`~/.config/chitti/accounts.json`, with directory mode `0700` and file mode `0600`.
Writes are atomic, and refreshes are serialized per account. `CHITTI_CONFIG_DIR`
can select another protected local directory. Do not share this directory.
Provider tokens never enter the website, browser storage, logs or exports.

The companion sends conversation context and tool definitions to the public
Responses API, with `store: false` and `stream: true`. Only a completed stream
counts as a finished response. Model choices come from the signed-in account;
there is no hardcoded subscription model list or fallback to paid API keys.

Use **Disconnect** to revoke the renewable session and clear its local tokens.
The account/client mapping and host ID remain for later sign-in. If remote
revocation fails, Chitti reports that explicitly. Review/revoke app permissions
and control any credit use in [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage).
Stopping the companion does not revoke the saved login.

## Verification

Tests cover authorization state, PKCE, identity validation before activation,
account isolation, token rotation, sign-out, origin checks, tool conversion and
stream failures. A real subscription request additionally requires the user to
complete ChatGPT consent; tests do not use a private account or stored Codex token.
