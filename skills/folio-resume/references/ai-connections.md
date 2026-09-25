<!-- Generated from docs/tutorials/ai-connections.md; run npm run skill:build after editing the guide. -->

# Connect and choose your AI

All connection setup and selection happen in **Settings → AI connections**. You do not need AI to edit Code or build a PDF locally.

[Screenshot: Empty AI connections page](https://github.com/grawish/folio/blob/main/docs/images/connections-empty.png)

## Use an installed Codex connection

1. Install the provider's supported Codex command on your Mac and sign in to your own account using its supported sign-in flow.
2. In Folio, open **Settings → AI connections → Add connection**.
3. Choose **Codex subscription**. Give the connection a name.
4. Leave **App location** empty to let Folio find the command. If it is not found, enter the full path to your installed executable.
5. Leave **Model** empty for the account default, or enter a model your account can use.
6. Choose **Save connection**, then select its radio button in the connections list.
7. Use **Check connection**. If sign-in is needed, use **Sign in** and finish the provider's flow. **Cancel sign-in** stops a pending sign-in.
8. Use **Test image support** before working with PDF feedback. This sends a small sample image and may use provider quota.

[Screenshot: Codex connection form](https://github.com/grawish/folio/blob/main/docs/images/connection-codex.png)

The screenshot shows an empty setup example, not a connected account. Folio uses the installed command; it does not turn a subscription into an API key. Account eligibility, quotas and model access are controlled by the provider.

## Use an installed Claude Code connection

Follow the same steps, choosing **Claude Code subscription** instead. The installed command must be available and signed in. Use **App location** if Folio cannot find it, then check the connection and test image support.

[Screenshot: Claude Code connection form](https://github.com/grawish/folio/blob/main/docs/images/connection-claude-code.png)

The adapter and local protocol tests exist. Live signed-in Claude acceptance is still on the release checklist; this form screenshot does not establish it.

## Bring your own API key

1. Choose **OpenAI API key** or **Anthropic API key**.
2. Enter a useful connection name, your own API key, and an image-capable model ID available to you.
3. Save, select the connection, check it, and test image support.
4. Close Settings and send a small request in Chat.

[Screenshot: OpenAI key connection form](https://github.com/grawish/folio/blob/main/docs/images/connection-openai.png)

[Screenshot: Anthropic key connection form](https://github.com/grawish/folio/blob/main/docs/images/connection-anthropic.png)

These screenshots contain no keys. Your API provider bills API use separately. Folio stores keys using protected local storage. Never paste a key into Chat, a resume file, a screenshot or a bug report. Live real-key acceptance remains unverified in this preview; local fixture tests cover the app's protocol handling.

## Use a compatible service

Choose **Custom API connection**. Select the service's actual API format: OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages. Enter its **Base URL**, **Model**, and key if required. Save it, select it, and test it. The service must support the selected format and images; a text-only endpoint cannot review PDF images.

[Screenshot: Custom API connection form](https://github.com/grawish/folio/blob/main/docs/images/connection-custom.png)

## Change or remove a connection

Select a different connection's radio button in Settings. The change applies to your next message. Use the settings icon on a row to edit its name, model or other details. When editing, an empty key field keeps the saved key; a custom connection also offers **Remove the saved key**.

**Remove connection from Folio** removes its Folio configuration. It does not sign you out of the provider's separate installed app. Removing a connection does not remove your resume or chat history.

If a check fails, read its message, confirm the command or endpoint, and check your provider account. Do not repeatedly send paid requests to diagnose a typo. A successful connection check is separate from a successful image-support test.

**Demo:** `npm run demo:capture` captures these real forms with no credentials. `npm run test:chat` exercises a local custom-provider fixture. Neither command proves live account eligibility.
