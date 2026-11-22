INSERT INTO client (client_id, phone_number, client_name) VALUES
    ('CLI-0042', '33612345678', 'Le Cedar Room'),
    ('CLI-0043', '33698765432', 'Harbor Kitchen'),
    ('CLI-0044', '33655443322', 'North Pier Grill')
ON CONFLICT DO NOTHING;

INSERT INTO product (product_id, product_name, price, stock) VALUES
    ('ART-TOM-GR-01', 'Tomates grappe', 2.45, 40),
    ('ART-CAB-35', 'Cabillaud 3/5', 14.90, 18),
    ('ART-SAL-12', 'Saumon 12', 18.50, 12),
    ('ART-PRW-3040', 'Crevettes 30/40', 21.00, 25)
ON CONFLICT DO NOTHING;
