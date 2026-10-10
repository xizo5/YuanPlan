-- An audit-only identity: disabled, no password account, no memberships or privileges.
INSERT INTO users(id,name,email,is_admin,disabled,identity_source)
VALUES ('system:account-recovery','系统账号恢复','account-recovery@system.invalid',false,true,'setup');
CREATE INDEX recovery_tokens_user_idx ON recovery_tokens(user_id) WHERE consumed_at IS NULL;
