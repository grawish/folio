<!-- Generated from docs/tutorials/app-updates.md; run npm run skill:build after editing the guide. -->

# Check for a new Folio version

These screens are in the current source build. The older public preview 4 does not have them. Automatic installation is still waiting for a signed production release and publisher setup.

1. Open **Settings → App updates**. You can also choose **Folio → Check for updates…** from the Mac menu.
2. Pick **Stable** for regular releases or **Beta** to try upcoming changes.
3. Click **Check for updates**. You can turn on **Check automatically** to check after launch and every six hours.

[Screenshot: App update settings in the dark theme](https://github.com/grawish/folio/blob/main/docs/images/app-updates-dark.png)

Checking does not download a new app or restart your work. Folio checks the publisher's signature before trusting a release. Your resume and chat are not sent with the check.

## What the preview shows

The current preview says that app releases are not configured. That is expected: it will not install an unsigned update. **Downloads on GitHub** opens the available releases so you can read their instructions. Use the exact release notes to see whether a download is signed and which features it includes.

Your Stable/Beta choice stays selected when you close and reopen Folio. Switching to Stable never installs an older app. If you already have a newer beta, you may need to wait for the next stable release.

[Screenshot: App update settings in the light theme](https://github.com/grawish/folio/blob/main/docs/images/app-updates-light.png)

## When signed updates become available

Folio will offer **Download update** for a newer release that supports your Mac and local data. Some releases reach a small group first. If your update is not ready yet, check again later.

After downloading, **Save recovery & restart** saves your source draft, chat, PDF notes and unfinished chat message locally before restarting. Finish any running save, build or AI request first. If saving fails, Folio stays open. Use the normal **Save** command as well when you want the project folder to contain your latest work.

The next launch will tell you whether the update finished. If it did not, your recovery copy remains available. Check again or use the GitHub download instructions. Do not delete your project or recovery folder to fix an update.

**Demo:** `npm run test:updates` checks the real preview Settings and close/reopen behavior using a made-up project and chat draft. It does not demonstrate a signed app installation. See [developer details and remaining tests](APP_UPDATES.md).
