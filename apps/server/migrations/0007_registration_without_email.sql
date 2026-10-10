ALTER TABLE users DROP CONSTRAINT users_identity_source_check;
ALTER TABLE users ADD CONSTRAINT users_identity_source_check CHECK(identity_source IN ('email','invite','setup','self','admin'));
ALTER TABLE instance_settings DROP CONSTRAINT instance_settings_registration_mode_check;
ALTER TABLE instance_settings ADD CONSTRAINT instance_settings_registration_mode_check CHECK(registration_mode IN ('invite','open','open_unverified'));
