-- Connections used to be definable in the app configuration and were then read-only in the web interface.
-- That option is gone; connections that came from it stay and become ordinary ones.
UPDATE connections SET managed = 0 WHERE managed <> 0;
