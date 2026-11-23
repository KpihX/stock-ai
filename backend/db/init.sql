CREATE TABLE IF NOT EXISTS client (
    client_id TEXT PRIMARY KEY,
    phone_number TEXT UNIQUE NOT NULL,
    client_name TEXT NOT NULL
);

INSERT INTO client (client_id, phone_number, client_name) VALUES
    ('CLI-0001', '33745717350', 'KpihX')
ON CONFLICT (client_id) DO UPDATE
SET phone_number = EXCLUDED.phone_number,
    client_name = EXCLUDED.client_name;
