# Gatekeeper Firebase

This package provides Firebase integration for Gadgets via the [Firebase Management REST
API](https://firebase.google.com/docs/projects/api/reference), the [Firestore REST
API](https://firebase.google.com/docs/firestore/reference/rest), and the [Realtime Database REST
API](https://firebase.google.com/docs/database/rest/start), using Google OAuth 2.0.

Firebase is a Google service, so authentication uses the same Google OAuth 2.0 endpoints as the
Google gatekeeper (accounts.google.com for authorization, oauth2.googleapis.com for token
exchange).

It exposes three resource granularities:

- **Firebase Project** (`https://console.firebase.google.com/project/:projectId/*`) — the
  broad unit. Discover Firestore databases, Realtime Database instances, and Auth users across
  the project.
- **Firestore Database** (`https://firestore.googleapis.com/projects/:projectId/databases/:databaseId/*`)
  — the recommended unit for document CRUD and queries.
- **Realtime Database** (`https://:projectId-default-rtdb.firebaseio.com/*`) — JSON tree CRUD.

A connected account corresponds to the Google account the user authorizes during the OAuth
consent flow.

## Creating the OAuth app

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services →
   Credentials.
2. Create an **OAuth 2.0 Client ID** (Web application type).
3. Set the **Authorized redirect URI** to your deployment's callback (replace the host with
   `PUBLIC_BASE_URL`):

   ```
   ${PUBLIC_BASE_URL}/gatekeeper/firebase/oauth
   ```

   For local development that is `http://localhost:8787/gatekeeper/firebase/oauth`.
4. Enable the **Firebase Management API** and **Cloud Firestore API** in your GCP project.
5. After creating the app, copy the **Client ID** and **Client Secret**.

> Use the OAuth app's **Client ID + Client Secret** — not a Firebase service account key. The
> `authorization_code` exchange requires the OAuth app credentials.

## Configuration

The gatekeeper Worker reads `CLIENT_ID` and `CLIENT_SECRET`. In local development these are
seeded from shell/`.dev.vars` variables by `run-dev-server.js`:

```
FIREBASE_CLIENT_ID=<oauth app client id>
FIREBASE_CLIENT_SECRET=<oauth app client secret>
```

## Notes

- Reads (get/list documents, run queries, RTDB get, list auth users) are logged as observations.
- Writes (create/update/delete documents, RTDB set/update/push/remove) are submitted to the
  approval queue and only run once a human approves them. Reads do not reflect pending writes;
  a write becomes visible only after it is approved and applied.
- RTDB `push()` returns a placeholder key (`pending-<actionId>`) at submission time because the
  real child key is generated only when the action is applied after approval.
- `listRealtimeDatabases()` reports a single `*-default-rtdb` instance derived from the project
  ID; the Firebase Management API has no direct RTDB list endpoint.
- `types.txt` should be a symlink to `types.d.ts`. When created via the GitHub API (which does
  not support symlinks), it is a copy; fix the symlink locally after cloning.
