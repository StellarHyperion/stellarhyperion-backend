-- The integration suite migrates and truncates its own database. Creating it here rather than
-- from the test run means a failed test never leaves a half created database behind, and the
-- suite never needs rights to CREATE DATABASE.
CREATE DATABASE hyperion_test OWNER hyperion;
