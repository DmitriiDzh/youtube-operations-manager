// Shared by both `/api/cloud-connection/start` and `/api/cloud-connection/callback` -- Google
// rejects a token exchange whose redirect_uri does not match the one used to start the flow
// byte-for-byte, so both routes must compute this identically rather than each building the
// string independently.
export function cloudConnectionCallbackRedirectUri(): string {
  return `${process.env.NEXTAUTH_URL}/api/cloud-connection/callback`;
}
