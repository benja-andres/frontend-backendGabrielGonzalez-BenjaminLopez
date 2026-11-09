-- Catálogo del frontend (productos.html y combos.html). Precios en CLP, tamaño mediano = precio base.
INSERT INTO sizes (code, label, volume_ml, price_delta, nutrition_factor) VALUES
  ('small',  'Pequeño',  350, -500, 0.7),
  ('medium', 'Mediano',  500,    0, 1.0),
  ('large',  'Grande',   700,  900, 1.4),
  ('fixed',  'Shot',      80,    0, 1.0);

INSERT INTO products (id, slug, name, description, category, base_price, fixed_size, image_url, badge, search_terms, kcal, carbs, sugars, protein, fat, fiber) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'smoothie-green-detox',   'Smoothie Green Detox',   'Espinaca, piña, manzana verde, limón y jengibre.',            'smoothie', 4590, 0, 'https://images.unsplash.com/photo-1610970881699-44a5587cabec?auto=format&fit=crop&w=600&q=80', 'Más vendido', 'smoothie green detox espinaca piña manzana', 180, 42, 30, 4, 1, 7),
  ('b0000000-0000-4000-8000-000000000002', 'smoothie-berry-power',   'Smoothie Berry Power',   'Frutilla, arándano, frambuesa, plátano y bebida vegetal.',    'smoothie', 4890, 0, 'https://images.unsplash.com/photo-1553530666-ba11a7da3888?auto=format&fit=crop&w=600&q=80',  'Favorito',    'smoothie berry power frutilla arándano', 230, 49, 35, 4, 3, 8),
  ('b0000000-0000-4000-8000-000000000003', 'smoothie-tropical-boost','Smoothie Tropical Boost','Mango, piña, maracuyá, plátano y agua de coco.',              'smoothie', 4690, 0, 'img/productos/web/smoothie-tropical-boost.webp', NULL,          'smoothie tropical boost mango piña maracuyá', 250, 58, 44, 3, 2, 6),
  ('b0000000-0000-4000-8000-000000000004', 'jugo-energia-citrica',   'Jugo Energía Cítrica',   'Naranja, mandarina, zanahoria y un toque de cúrcuma.',        'jugo',     3990, 0, 'https://images.unsplash.com/photo-1600271886742-f049cd451bba?auto=format&fit=crop&w=600&q=80', 'Nuevo',       'jugo energía cítrica naranja mandarina zanahoria', 190, 44, 36, 3, 1, 5),
  ('b0000000-0000-4000-8000-000000000005', 'jugo-rojo-vital',        'Jugo Rojo Vital',        'Betarraga, frutilla, manzana roja, naranja y limón.',         'jugo',     4290, 0, 'https://images.unsplash.com/photo-1595981267035-7b04ca84a82d?auto=format&fit=crop&w=600&q=80', NULL,          'jugo rojo vital betarraga frutilla manzana', 200, 46, 34, 4, 1, 6),
  ('b0000000-0000-4000-8000-000000000006', 'jugo-manzana-fresh',     'Jugo Manzana Fresh',     'Manzana verde, pepino, limón, menta y agua filtrada.',        'jugo',     4190, 0, 'img/productos/web/jugo-manzana-fresh.webp', NULL,          'jugo manzana fresh manzana pepino limón', 170, 40, 31, 2, 1, 5),
  ('b0000000-0000-4000-8000-000000000007', 'protein-cacao',          'Protein Cacao',          'Cacao, plátano, avena, proteína vegetal y bebida de almendras.', 'batido', 5490, 0, 'img/productos/web/protein-cacao.webp', '25 g proteína', 'batido protein cacao plátano proteína', 430, 55, 28, 25, 12, 8),
  ('b0000000-0000-4000-8000-000000000008', 'vainilla-fit',           'Vainilla Fit',           'Proteína de vainilla, plátano, avena y bebida de coco.',      'batido',   5290, 0, 'img/productos/web/vainilla-fit.webp', '24 g proteína', 'batido vainilla fit proteína plátano', 390, 52, 25, 24, 8, 7),
  ('b0000000-0000-4000-8000-000000000009', 'peanut-power',           'Peanut Power',           'Mantequilla de maní, cacao, plátano y proteína vegetal.',     'batido',   5690, 0, 'img/productos/web/peanut-power.webp', '26 g proteína', 'batido peanut power maní cacao proteína', 480, 48, 24, 26, 19, 7),
  ('b0000000-0000-4000-8000-000000000010', 'shot-defensa',           'Shot Defensa',           'Jengibre, limón, naranja, cúrcuma y pimienta negra.',         'shot',     1990, 1, 'img/productos/web/shot-defensa.webp', 'Shot',        'shot defensa jengibre limón cúrcuma', 45, 10, 6, 1, 0, 1);

INSERT INTO stock (product_id, on_hand, reserved) SELECT id, 100, 0 FROM products;

INSERT INTO combos (id, slug, name, description, price, badge, image_url) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'combo-pareja',        'Combo Pareja',        'Dos smoothies medianos de 500 ml a elección y dos shots de jengibre de 80 ml.', 10990, '-15%',   'https://images.unsplash.com/photo-1622597467836-f3285f2131b8?auto=format&fit=crop&w=800&q=80'),
  ('c0000000-0000-4000-8000-000000000002', 'pack-semanal-detox',  'Pack Semanal Detox',  'Cinco smoothies Green Detox medianos de 500 ml, uno para cada día laboral.',   18990, '5 días', 'https://images.unsplash.com/photo-1610970881699-44a5587cabec?auto=format&fit=crop&w=800&q=80'),
  ('c0000000-0000-4000-8000-000000000003', 'duo-energetico',      'Dúo Energético',      'Dos jugos Energía Cítrica medianos de 500 ml y un shot Defensa de 80 ml.',      8490, NULL,     NULL),
  ('c0000000-0000-4000-8000-000000000004', 'pack-protein',        'Pack Protein',        'Dos batidos proteicos medianos de 500 ml: Cacao y Vainilla Fit.',               9990, NULL,     NULL),
  ('c0000000-0000-4000-8000-000000000005', 'trio-natural',        'Trío Natural',        'Green Detox, Berry Power y Tropical Boost en tamaño mediano de 500 ml.',       12490, NULL,     NULL);

INSERT INTO combo_items (combo_id, product_id, category, qty) VALUES
  ('c0000000-0000-4000-8000-000000000001', NULL,                                   'smoothie', 2),
  ('c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000010', NULL,       2),
  ('c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', NULL,       5),
  ('c0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000004', NULL,       2),
  ('c0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000010', NULL,       1),
  ('c0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000007', NULL,       1),
  ('c0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000008', NULL,       1),
  ('c0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000001', NULL,       1),
  ('c0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000002', NULL,       1),
  ('c0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000003', NULL,       1);
