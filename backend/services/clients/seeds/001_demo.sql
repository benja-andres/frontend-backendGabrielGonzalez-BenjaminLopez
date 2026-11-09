-- Datos ficticios de prueba. Los ids coinciden con los usuarios de demostración del Auth Service.
INSERT INTO clients (id, email, name, phone) VALUES
  ('00000000-0000-4000-8000-000000000001', 'admin@naturalpower.test',    'Administrador Demo', NULL),
  ('00000000-0000-4000-8000-000000000002', 'cliente1@naturalpower.test', 'Cliente Uno',        '+56 9 1111 1111'),
  ('00000000-0000-4000-8000-000000000003', 'cliente2@naturalpower.test', 'Cliente Dos',        '+56 9 2222 2222');

INSERT INTO addresses (id, client_id, label, street, comuna, notes, is_default) VALUES
  ('a0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'Casa',    'Av. Ficticia 123, depto 45', 'Providencia', 'Conserjería recibe pedidos', 1),
  ('a0000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', 'Oficina', 'Calle de Prueba 456',        'Ñuñoa',       NULL, 1);
