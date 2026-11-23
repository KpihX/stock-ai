INSERT INTO client (client_id, phone_number, client_name) VALUES
    ('CLI-0001', '33745717350', 'KpihX')
ON CONFLICT (client_id) DO UPDATE
SET phone_number = EXCLUDED.phone_number,
    client_name = EXCLUDED.client_name;
