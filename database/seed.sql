INSERT OR IGNORE INTO vehicles (name, vehicle_number, seating_capacity, base_fare, rate_per_km, ac, fuel_type, status)
VALUES
('Sedan', 'TN-XX-XX-0002', 4, 500, 12, 1, 'Petrol', 'AVAILABLE'),
('Innova Crysta', 'TN-XX-XX-0001', 7, 800, 16, 1, 'Diesel', 'AVAILABLE'),
('Tempo Traveller', 'TN-XX-XX-0003', 12, 1500, 22, 1, 'Diesel', 'AVAILABLE');

INSERT OR IGNORE INTO drivers (name, mobile, vehicle_id, status)
VALUES
('Kumar', '9000000001', 2, 'AVAILABLE'),
('Ravi', '9000000002', 1, 'AVAILABLE');
