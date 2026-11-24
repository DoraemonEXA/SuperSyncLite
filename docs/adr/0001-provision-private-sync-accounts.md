# Provision private sync accounts through an administrator

SuperSync Lite serves multiple users on one deployment. Each user owns a separate dataset so that adding another account never joins two people's sync histories. The administration interface manages accounts and does not expose their task content.

An administrator creates each account in a web interface and gives its authenticator enrollment QR code to the user. Hosted accounts sign in with a username and a six-digit time-based one-time password (TOTP). For local testing, the Wrangler development launcher allows a provisioned administrator to enter just their username. Regular users authenticate with TOTP in every environment.

The deployment operator provisions the first administrator and recovers administrator access with a local command. An administrator can replace a user's lost authenticator. Replacement preserves the dataset, invalidates the previous authenticator and revokes the account's web sessions and device authorizations. Each device must be authorized again.

A signed-in user can revoke all their sync device tokens while retaining their web sessions, dataset and Capture authorizations. The user can then generate a token in the portal or approve a new pairing. Both actions use the existing device authorization protocol.
