import { importPKCS8, SignJWT } from 'jose';

export interface FcmMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

function parseServiceAccount(json: string): { clientEmail: string; privateKey: string; projectId: string } {
  const parsed = JSON.parse(json);
  if (!parsed.client_email || !parsed.private_key || !parsed.project_id) {
    throw new Error('Service account JSON must include client_email, private_key, and project_id');
  }
  return {
    clientEmail: parsed.client_email,
    privateKey: parsed.private_key,
    projectId: parsed.project_id,
  };
}

async function getAccessToken(privateKey: string, clientEmail: string): Promise<string> {
  const key = await importPKCS8(privateKey.replace(/\\n/g, '\n'), 'RS256');
  const jwt = await new SignJWT({
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuedAt()
    .setIssuer(clientEmail)
    .setAudience('https://oauth2.googleapis.com/token')
    .setExpirationTime('1h')
    .sign(key);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error('Failed to fetch OAuth token: ' + text);
  }

  const data = await response.json<{ access_token: string }>();
  return (data as any).access_token;
}

export async function sendFcmNotification(token: string, projectId: string, message: FcmMessage, serviceAccountJson: string): Promise<{ ok: true } | { ok: false; shouldRemove: boolean; error: string }> {
  const { clientEmail, privateKey } = parseServiceAccount(serviceAccountJson);
  const accessToken = await getAccessToken(privateKey, clientEmail);

  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        message: {
          token,
          notification: {
            title: message.title,
            body: message.body,
          },
          data: message.data,
        },
      }),
    },
  );

  if (response.ok) {
    return { ok: true };
  }

  const status = response.status;
  const body = await response.text();
  // FCM HTTP v1 returns 404 when token is unregistered and 410 when it is no longer valid.
  const shouldRemove = status === 404 || status === 410;
  return { ok: false, shouldRemove, error: body };
}
