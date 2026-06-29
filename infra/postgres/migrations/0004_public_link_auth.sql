-- Allow public_link auth type for Google Drive connectors (shared folder URL only).
ALTER TABLE drive_connectors DROP CONSTRAINT IF EXISTS drive_connectors_auth_type_check;
ALTER TABLE drive_connectors ADD CONSTRAINT drive_connectors_auth_type_check
  CHECK (auth_type IN ('public_link', 'service_account', 'access_token'));
