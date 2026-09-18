-- The interface is English unless an account switches it in Settings, so a row
-- that never said otherwise should read 'en'. Existing rows are left alone:
-- whatever they hold, somebody chose it.
alter table user_settings alter column assistant_language set default 'en';
