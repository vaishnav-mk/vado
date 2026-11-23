// No dots, so no database name can form a replica's.
export const DB_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const DB_NAME_RULE = "database names are 1-63 characters of a-z 0-9 _ -, starting with a letter or digit";
