ALTER TABLE users ADD COLUMN identity_source text NOT NULL DEFAULT 'email' CHECK(identity_source IN ('email','invite','setup'));
