<!-- Generated from docs/tutorials/ai-connections.md; run npm run skill:build after editing the guide. -->

# Connect and choose your AI

Set up and select connections in **Settings → AI connections**. Choose the model beside Send in Chat. You do not need AI to edit Code or build a PDF locally.

[Screenshot: Empty AI connections page](https://github.com/grawish/folio/blob/main/docs/images/connections-empty.png)

## Use an installed Codex connection

1. Install the provider's supported Codex command on your Mac and sign in to your own account using its supported sign-in flow.
2. In Folio, open **Settings → AI connections → Add connection**.
3. Choose **Codex subscription**. Give the connection a name.
4. Leave **App location** empty to let Folio find the command. If it is not found, enter the full path to your installed executable.
5. For Codex, leave **Model** empty only when your configured Codex default is supported. Otherwise enter a model returned by **Check connection**; an unsupported personal CLI default can make image support fail.
6. Choose **Save connection**, then select its radio button in the connections list.
7. Use **Check connection**. If sign-in is needed, use **Sign in** and finish the provider's flow. **Cancel sign-in** stops a pending sign-in.
8. Use **Test image support** before working with PDF feedback. This sends a small sample image and may use provider quota.

[Screenshot: Codex connection form](https://github.com/grawish/folio/blob/main/docs/images/connection-codex.png)

The screenshot shows an empty setup example, not a connected account. Folio uses the installed command; it does not turn a subscription into an API key. Account eligibility, quotas and model access are controlled by the provider.

## Use an installed Claude Code connection

Follow the same steps, choosing **Claude Code subscription** instead. The installed command must be available and signed in. Use **App location** if Folio cannot find it, then check the connection and test image support.

[Screenshot: Claude Code connection form](https://github.com/grawish/folio/blob/main/docs/images/connection-claude-code.png)

This form is an empty setup example. The separate live test below uses a signed-in Claude Code subscription.

### Try a PDF note with Claude Code

1. Select your Claude Code connection in **Settings** and choose **Test image support**. Wait for **Image support verified**.
2. Close Settings. Open a small sample resume and wait for **Up to date** beside the PDF.
3. Use **Box an area** to mark a heading. Write a clear note, such as “Change Projects to Selected Projects. Keep everything else unchanged.” Choose **Save note**.
4. Choose **Attach 1 to chat**, explain the change in Chat, then choose **Send**.
5. Wait for **Visually checked**. Read the changed PDF yourself, then choose **Save** and wait for **Saved locally**. Use **Export PDF** for a clean copy.

[Screenshot: Claude Code selected in Settings with image support verified](https://github.com/grawish/folio/blob/main/docs/images/claude-live-settings.png)

[Screenshot: A note around the Projects heading on page two, attached to Chat](https://github.com/grawish/folio/blob/main/docs/images/claude-live-annotation.png)

[Screenshot: The real Claude response and the changed Selected Projects heading](https://github.com/grawish/folio/blob/main/docs/images/claude-live-completed.png)

On 27 September 2026, this workflow passed in the source-built Mac app with installed Claude Code 2.1.282, the `sonnet` alias, and the returned model identifier `claude-sonnet-5`. Only a made-up two-page document was sent. The check confirmed the exact heading-only source change, local compilation, visual review, matching PDF export and saved source/conversation after reopening. It used the existing subscription and no API key. See the [verification record](https://github.com/grawish/folio/blob/main/docs/releases/claude-live-verification.json).

This is one account and one model workflow. It does not verify every account, model, macOS version or signed installer. Image checks and chats use your provider allowance. If automatic compilation is off, choose **Compile** after reopening to rebuild the preview.

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

## Choose a model in Chat

The selector beside **Send** offers **Auto**, **Connection default**, and the connection's available models. The connection name opens its settings. Choices are remembered per connection and apply to the next message; an in-flight request keeps its captured connection and selection.

**Auto** uses a Fast model for clear wording changes and source questions, and a Capable model for layout work, PDF notes, broad edits, or uncertain source. It can escalate after an invalid edit or failed build, with at most three edit attempts. Replies show which model was used. Choosing a specific model keeps that model fixed throughout the request.

Edit the connection's **Fast model** and **Capable model** fields to override the suggested roles. Codex and API connections discover models where supported. Claude Code offers its provider aliases. Custom endpoints use the configured model for both roles until you set separate choices. If discovery is unavailable, configured models remain selectable. Image support belongs to each model; testing the connection default does not verify every model in the picker.

New connections start in Auto. Connections saved by earlier versions retain their configured default until you choose Auto. Auto never changes the provider or account for you. Provider usage and billing still apply.

## Change or remove a connection

Select a different connection's radio button in Settings. The change applies to your next message. Use the settings icon on a row to edit its name, model or other details. When editing, an empty key field keeps the saved key; a custom connection also offers **Remove the saved key**.

**Remove connection from Folio** removes its Folio configuration. It does not sign you out of the provider's separate installed app. Removing a connection does not remove your resume or chat history.

If a check fails, read its message, confirm the command or endpoint, and check your provider account. Do not repeatedly send paid requests to diagnose a typo. A successful connection check is separate from a successful image-support test.

**Demos:** `npm run demo:capture` captures the empty forms. `npm run test:chat` uses a local provider fixture. To repeat the separate live Claude test after building, run `node scripts/test-live-claude.mjs --live` on a Mac with Claude Code already signed in. This opt-in command sends its synthetic document and PDF images and consumes provider usage; it is not run in CI.

### Repeat the live Codex check

With an already signed-in Codex CLI account, build the source app and run:

```sh
node scripts/test-live-codex.mjs --live
```

The opt-in check sends only its synthetic two-page document and generated PDF images. It pins the account-supported `gpt-5.5` model rather than inheriting a personal Codex configuration default, then verifies image support, annotated edit, local compilation, visual review, exact export and reopen. It consumes account usage and is not CI. One source-build account/model workflow passed on 29 September 2026; it does not establish signed-release or every-account/model acceptance.
