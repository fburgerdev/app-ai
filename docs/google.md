# Connecting Gmail and Google Calendar

The app signs in to Google as you, through a Google Cloud project that belongs to you. Nobody else is involved, and it costs nothing. Setting it up takes about ten minutes, once. Google renames its console pages now and then, so a label below may read slightly differently.

## What threads can do afterwards

- Threads can search and read your mail, read your calendar, and add an entry to it.
- A mail Claude writes gets two buttons: **Put in Gmail** (a draft) and **Send** (after one confirmation). Only your click uses them.
- "Update brain" also reads the mail that arrived and went out since the last update.

Claude has no tool for saving drafts, sending mail, deleting anything or inviting people, so a thread cannot do those, whatever it is told. Sending exists only behind the Send button.

## Steps

1. Open https://console.cloud.google.com and create a project (any name, for example "Inbox").
2. **Enable two APIs**: under "APIs & Services" → "Library", search for and enable **Gmail API** and **Google Calendar API**.
3. **Consent screen**: under "APIs & Services" → "OAuth consent screen" (or "Google Auth Platform"), choose **External**, give the app a name and your mail address. Add your own Google address under **Test users**.
4. **Publish it**: on the same page, set the publishing status to **In production**. You do not need to submit it for verification. Without this step Google signs you out every seven days.
5. **Create the client**: under "Credentials" → "Create credentials" → "OAuth client ID", type **Web application**. Under "Authorized redirect URIs" add:
   - `http://localhost:4317/auth/google/callback`
   - if you run the app on the Pi: `https://<the Pi's tailnet name>/auth/google/callback` as well
6. Copy the **client ID** and **client secret** into `config.json` in the app's data folder:
   ```json
   "google": { "clientId": "….apps.googleusercontent.com", "clientSecret": "…" }
   ```
7. Restart the app. Open **Connections** (bottom left) and press **Connect Google**. Sign in with the account that holds your mail (the personal one; PBU mail is forwarded into it).
8. Google shows a warning that the app is not verified. That is expected for your own project: choose "Advanced" → "Go to … (unsafe)", then allow the three permissions.

Connections now shows "connected". Every new turn in every thread can use mail and calendar.

## Good to know

- The sign-in is kept in `google-token.json` in the app's data folder. "Disconnect" in Connections deletes it. To withdraw access on Google's side as well: https://myaccount.google.com/permissions.
- A mail is a file in its thread. You can edit it there, and every version is kept, yours and Claude's.
- If a thread reports that Google refused the sign-in, connect again in Connections.
