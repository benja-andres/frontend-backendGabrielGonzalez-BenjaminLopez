document.addEventListener("DOMContentLoaded", () => {
  const storageKey = "naturalPowerCart";
  const cartCount = document.querySelector(".cart-count");
  const cartItems = document.querySelector(".cart-items");
  const emptyCart = document.querySelector(".empty-cart");
  const cartSummary = document.querySelector(".cart-summary");
  const cartTotal = document.querySelector(".cart-total");
  const toastElement = document.querySelector(".cart-toast");
  const toastMessage = document.querySelector(".toast-message");
  const cartToast = bootstrap.Toast.getOrCreateInstance(toastElement, {
    delay: 2300,
  });
  const currency = new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  });

  // Recupera el carrito guardado. Si no existe, comienza con uno vacío.
  let cart = [];
  try {
    cart = JSON.parse(localStorage.getItem(storageKey)) || [];
  } catch (error) {
    cart = [];
  }

  function saveCart() {
    localStorage.setItem(storageKey, JSON.stringify(cart));
  }

  function getItemCount() {
    return cart.reduce((total, item) => total + item.quantity, 0);
  }

  function showMessage(message) {
    toastMessage.textContent = message;
    cartToast.show();
  }

  function renderCart() {
    const total = cart.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );

    cartCount.textContent = getItemCount();
    emptyCart.classList.toggle("d-none", cart.length > 0);
    cartSummary.classList.toggle("d-none", cart.length === 0);
    cartTotal.textContent = currency.format(total);

    cartItems.innerHTML = cart
      .map(
        (item, index) => `
      <div class="cart-item">
        <img src="${item.image}" alt="">
        <div>
          <h3>${item.name}</h3>
          <p>${currency.format(item.price)}</p>
        </div>
        <div class="item-quantity" aria-label="Cantidad de ${item.name}">
          <button type="button" data-action="decrease" data-index="${index}" aria-label="Quitar una unidad"><i class="bi bi-dash"></i></button>
          <span>${item.quantity}</span>
          <button type="button" data-action="increase" data-index="${index}" aria-label="Añadir una unidad"><i class="bi bi-plus"></i></button>
        </div>
      </div>
    `,
      )
      .join("");
  }

  function addItem(productName, price, image) {
    const existingItem = cart.find((item) => item.name === productName);

    if (existingItem) {
      existingItem.quantity += 1;
    } else {
      cart.push({ name: productName, price, image, quantity: 1 });
    }

    saveCart();
    renderCart();
    showMessage(`${productName} añadido al carrito.`);
  }

  // Valores aproximados para una porción mediana de 500 ml (shot: 80 ml).
  const nutritionData = {
    "Smoothie a elección": {
      kcal: 220,
      carbs: 50,
      sugars: 36,
      protein: 4,
      fat: 2,
      fiber: 7,
    },
    "Smoothie Green Detox": {
      kcal: 180,
      carbs: 42,
      sugars: 30,
      protein: 4,
      fat: 1,
      fiber: 7,
    },
    "Smoothie Berry Power": {
      kcal: 230,
      carbs: 49,
      sugars: 35,
      protein: 4,
      fat: 3,
      fiber: 8,
    },
    "Smoothie Tropical Boost": {
      kcal: 250,
      carbs: 58,
      sugars: 44,
      protein: 3,
      fat: 2,
      fiber: 6,
    },
    "Jugo Energía Cítrica": {
      kcal: 190,
      carbs: 44,
      sugars: 36,
      protein: 3,
      fat: 1,
      fiber: 5,
    },
    "Jugo Rojo Vital": {
      kcal: 200,
      carbs: 46,
      sugars: 34,
      protein: 4,
      fat: 1,
      fiber: 6,
    },
    "Jugo Manzana Fresh": {
      kcal: 170,
      carbs: 40,
      sugars: 31,
      protein: 2,
      fat: 1,
      fiber: 5,
    },
    "Protein Cacao": {
      kcal: 430,
      carbs: 55,
      sugars: 28,
      protein: 25,
      fat: 12,
      fiber: 8,
    },
    "Vainilla Fit": {
      kcal: 390,
      carbs: 52,
      sugars: 25,
      protein: 24,
      fat: 8,
      fiber: 7,
    },
    "Peanut Power": {
      kcal: 480,
      carbs: 48,
      sugars: 24,
      protein: 26,
      fat: 19,
      fiber: 7,
    },
    "Shot Defensa": {
      kcal: 45,
      carbs: 10,
      sugars: 6,
      protein: 1,
      fat: 0,
      fiber: 1,
    },
  };

  const comboProducts = {
    "Combo Pareja": [
      { name: "Smoothie a elección", portion: "500 ml" },
      { name: "Shot Defensa", portion: "80 ml" },
    ],
    "Pack Semanal Detox": [{ name: "Smoothie Green Detox", portion: "500 ml" }],
    "Dúo Energético": [
      { name: "Jugo Energía Cítrica", portion: "500 ml" },
      { name: "Shot Defensa", portion: "80 ml" },
    ],
    "Pack Protein": [
      { name: "Protein Cacao", portion: "500 ml" },
      { name: "Vainilla Fit", portion: "500 ml" },
    ],
    "Trío Natural": [
      { name: "Smoothie Green Detox", portion: "500 ml" },
      { name: "Smoothie Berry Power", portion: "500 ml" },
      { name: "Smoothie Tropical Boost", portion: "500 ml" },
    ],
  };

  const addButtons = document.querySelectorAll(".add-to-cart");
  const productButtons = [...addButtons].filter((button) =>
    button.closest(".product-card"),
  );
  const sizedButtons = productButtons.filter(
    (button) => button.dataset.name !== "Shot Defensa",
  );
  let pendingProduct = null;
  let sizeModal = null;

  // El tamaño se elige en una ventana antes de confirmar el producto.
  if (productButtons.length > 0) {
    const sizeModalElement = document.createElement("div");
    sizeModalElement.className = "modal fade";
    sizeModalElement.id = "sizeModal";
    sizeModalElement.tabIndex = -1;
    sizeModalElement.setAttribute("aria-labelledby", "sizeModalLabel");
    sizeModalElement.innerHTML = `
      <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable">
        <div class="modal-content size-modal">
          <div class="modal-header border-0">
            <div><span class="eyebrow">Personaliza tu pedido</span><h2 class="modal-title" id="sizeModalLabel">Elige el tamaño</h2></div>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Cerrar"></button>
          </div>
          <div class="modal-body pt-0">
            <div class="size-product-summary"><img class="size-product-image" src="" alt=""><div><h3 class="size-product-name"></h3><p class="size-summary-text">El precio cambia según el tamaño.</p></div></div>
            <div class="size-choice-group">
              <label class="form-label" for="modalSizeSelect">Tamaño</label>
              <select class="form-select size-select" id="modalSizeSelect">
                <option value="-500" data-factor="0.7" data-portion="350 ml">Pequeño (350 ml)</option>
                <option value="0" data-factor="1" data-portion="500 ml" selected>Mediano (500 ml)</option>
                <option value="900" data-factor="1.4" data-portion="700 ml">Grande (700 ml)</option>
              </select>
            </div>
            <div class="size-modal-price"><span>Precio</span><strong></strong></div>
            <section class="nutrition-panel" aria-labelledby="nutritionTitle">
              <div class="nutrition-heading"><h3 id="nutritionTitle">Información nutricional</h3><span class="nutrition-portion"></span></div>
              <div class="nutrition-grid">
                <div><span>Calorías</span><strong data-nutrient="kcal"></strong></div>
                <div><span>Carbohidratos</span><strong data-nutrient="carbs"></strong></div>
                <div><span>Azúcares</span><strong data-nutrient="sugars"></strong></div>
                <div><span>Proteínas</span><strong data-nutrient="protein"></strong></div>
                <div><span>Grasas</span><strong data-nutrient="fat"></strong></div>
                <div><span>Fibra</span><strong data-nutrient="fiber"></strong></div>
              </div>
            </section>
            <button type="button" class="btn btn-primary-brand w-100 confirm-size">Añadir al carrito</button>
          </div>
        </div>
      </div>
    `;
    document.body.append(sizeModalElement);
    sizeModal = bootstrap.Modal.getOrCreateInstance(sizeModalElement);

    const sizeSelect = sizeModalElement.querySelector(".size-select");
    const modalPrice = sizeModalElement.querySelector(
      ".size-modal-price strong",
    );
    const sizeChoiceGroup =
      sizeModalElement.querySelector(".size-choice-group");

    function updateNutrition(factor, portion) {
      const values = nutritionData[pendingProduct.name];
      sizeModalElement.querySelector(".nutrition-portion").textContent =
        `Porción: ${portion}`;

      Object.entries(values).forEach(([nutrient, value]) => {
        const unit = nutrient === "kcal" ? " kcal" : " g";
        sizeModalElement.querySelector(
          `[data-nutrient="${nutrient}"]`,
        ).textContent = `${Math.round(value * factor)}${unit}`;
      });
    }

    function updateModalPrice() {
      const selectedOption = sizeSelect.options[sizeSelect.selectedIndex];
      const price = pendingProduct.fixedSize
        ? pendingProduct.basePrice
        : pendingProduct.basePrice + Number(sizeSelect.value);
      modalPrice.textContent = currency.format(price);
      updateNutrition(
        pendingProduct.fixedSize ? 1 : Number(selectedOption.dataset.factor),
        pendingProduct.fixedSize ? "80 ml" : selectedOption.dataset.portion,
      );
    }

    sizeSelect.addEventListener("change", updateModalPrice);
    sizeModalElement
      .querySelector(".confirm-size")
      .addEventListener("click", () => {
        const selectedSize = pendingProduct.fixedSize
          ? "80 ml"
          : sizeSelect.options[sizeSelect.selectedIndex].text;
        const finalName = `${pendingProduct.name} (${selectedSize})`;
        const finalPrice = pendingProduct.fixedSize
          ? pendingProduct.basePrice
          : pendingProduct.basePrice + Number(sizeSelect.value);
        addItem(finalName, finalPrice, pendingProduct.image);
        sizeModal.hide();
      });

    function openProductModal(button) {
      pendingProduct = {
        name: button.dataset.name,
        basePrice: Number(button.dataset.price),
        image: button.dataset.image,
        fixedSize: button.dataset.name === "Shot Defensa",
      };
      sizeSelect.value = "0";
      sizeChoiceGroup.classList.toggle("d-none", pendingProduct.fixedSize);
      sizeModalElement.querySelector(".size-summary-text").textContent =
        pendingProduct.fixedSize
          ? "Porción individual de 80 ml."
          : "El precio y los valores cambian según el tamaño.";
      sizeModalElement.querySelector(".size-product-name").textContent =
        pendingProduct.name;
      sizeModalElement.querySelector(".size-product-image").src =
        pendingProduct.image;
      sizeModalElement.querySelector(".size-product-image").alt =
        pendingProduct.name;
      updateModalPrice();
      sizeModal.show();
    }

    productButtons.forEach((button) => {
      const productCard = button.closest(".product-card");
      if (button.dataset.name !== "Shot Defensa") {
        productCard.querySelector(".price small").textContent =
          "Mediano · 500 ml";
        button.addEventListener("click", () => openProductModal(button));
      }
    });
  }

  const comboButtons = [...addButtons].filter((button) =>
    button.closest(".combo-card"),
  );

  if (comboButtons.length > 0) {
    const nutrientLabels = {
      kcal: "Calorías",
      carbs: "Carbohidratos",
      sugars: "Azúcares",
      protein: "Proteínas",
      fat: "Grasas",
      fiber: "Fibra",
    };
    const comboModalElement = document.createElement("div");
    comboModalElement.className = "modal fade";
    comboModalElement.id = "comboNutritionModal";
    comboModalElement.tabIndex = -1;
    comboModalElement.setAttribute(
      "aria-labelledby",
      "comboNutritionModalLabel",
    );
    comboModalElement.innerHTML = `
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content combo-nutrition-modal">
          <div class="modal-header border-0">
            <div><span class="eyebrow">Conoce tu combo</span><h2 class="modal-title" id="comboNutritionModalLabel">Información nutricional</h2></div>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Cerrar"></button>
          </div>
          <div class="modal-body pt-0">
            <h3 class="combo-nutrition-name"></h3>
            <div id="comboNutritionCarousel" class="carousel slide" data-bs-interval="false">
              <div class="carousel-inner"></div>
              <button class="carousel-control-prev combo-carousel-control" type="button" data-bs-target="#comboNutritionCarousel" data-bs-slide="prev"><span class="carousel-control-prev-icon" aria-hidden="true"></span><span class="visually-hidden">Anterior</span></button>
              <button class="carousel-control-next combo-carousel-control" type="button" data-bs-target="#comboNutritionCarousel" data-bs-slide="next"><span class="carousel-control-next-icon" aria-hidden="true"></span><span class="visually-hidden">Siguiente</span></button>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.append(comboModalElement);
    const comboModal = bootstrap.Modal.getOrCreateInstance(comboModalElement);
    const carouselInner = comboModalElement.querySelector(".carousel-inner");
    const carouselControls = comboModalElement.querySelectorAll(
      ".combo-carousel-control",
    );

    comboButtons.forEach((button) => {
      const nutritionButton = document.createElement("button");
      nutritionButton.className = "nutrition-link combo-nutrition-link";
      nutritionButton.type = "button";
      nutritionButton.innerHTML =
        '<i class="bi bi-clipboard2-pulse"></i> Ver información nutricional';
      button.closest(".combo-card-footer").before(nutritionButton);

      nutritionButton.addEventListener("click", () => {
        const products = comboProducts[button.dataset.name];
        comboModalElement.querySelector(".combo-nutrition-name").textContent =
          button.dataset.name;
        carouselInner.innerHTML = products
          .map((product, index) => {
            const values = nutritionData[product.name];
            const nutrients = Object.entries(values)
              .map(([key, value]) => {
                const unit = key === "kcal" ? " kcal" : " g";
                return `<div><span>${nutrientLabels[key]}</span><strong>${value}${unit}</strong></div>`;
              })
              .join("");

            return `
              <div class="carousel-item${index === 0 ? " active" : ""}">
                <div class="combo-nutrition-slide">
                  <span class="combo-product-count">Producto ${index + 1} de ${products.length}</span>
                  <h4>${product.name}</h4>
                  <p>Porción: ${product.portion}</p>
                  <div class="nutrition-grid">${nutrients}</div>
                </div>
              </div>
            `;
          })
          .join("");

        carouselControls.forEach((control) => {
          control.classList.toggle("d-none", products.length === 1);
        });
        bootstrap.Carousel.getOrCreateInstance(
          document.getElementById("comboNutritionCarousel"),
          { interval: false },
        ).to(0);
        comboModal.show();
      });
    });
  }

  addButtons.forEach((button) => {
    if (sizedButtons.includes(button)) return;
    button.addEventListener("click", () => {
      addItem(
        button.dataset.name,
        Number(button.dataset.price),
        button.dataset.image,
      );
    });
  });

  cartItems.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;

    const index = Number(button.dataset.index);
    if (button.dataset.action === "increase") {
      cart[index].quantity += 1;
    } else {
      cart[index].quantity -= 1;
      if (cart[index].quantity === 0) cart.splice(index, 1);
    }

    saveCart();
    renderCart();
  });

  document.querySelector(".clear-cart").addEventListener("click", () => {
    cart = [];
    saveCart();
    renderCart();
  });

  document.querySelector(".checkout-button").addEventListener("click", () => {
    showMessage("Tu pedido está listo para continuar.");
  });

  // Filtra el catálogo o lleva la búsqueda a la página de productos.
  const searchForm = document.querySelector(".search-form");
  const searchInput = document.querySelector(".search-input");
  const productItems = document.querySelectorAll(".product-item");
  const noResults = document.querySelector(".no-results");

  function filterProducts(query) {
    let visibleProducts = 0;
    productItems.forEach((product) => {
      const matches = product.dataset.name
        .toLocaleLowerCase("es")
        .includes(query);
      product.classList.toggle("d-none", !matches);
      if (matches) visibleProducts += 1;
    });
    noResults.classList.toggle("d-none", visibleProducts > 0);
  }

  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = searchInput.value.trim().toLocaleLowerCase("es");
    if (!query) return;

    if (productItems.length > 0) {
      filterProducts(query);
      document
        .querySelector(".product-grid")
        .scrollIntoView({ behavior: "smooth" });
    } else {
      window.location.href = `productos.html?busqueda=${encodeURIComponent(query)}`;
    }
  });

  if (productItems.length > 0) {
    const urlQuery = new URLSearchParams(window.location.search).get(
      "busqueda",
    );
    if (urlQuery) {
      searchInput.value = urlQuery;
      filterProducts(urlQuery.toLocaleLowerCase("es"));
    }

    searchInput.addEventListener("input", () => {
      if (searchInput.value === "") filterProducts("");
    });
  }

  document.querySelector(".promo-close").addEventListener("click", () => {
    document.getElementById("promoBar").classList.add("d-none");
  });

  // Simula el ingreso o registro porque este proyecto no usa base de datos.
  document.querySelectorAll(".account-form").forEach((form) => {
    const passwordInput = form.querySelector('input[type="password"]');
    const nameInput = form.querySelector('input[autocomplete="name"]');

    passwordInput.minLength = 6;
    passwordInput.maxLength = 12;
    passwordInput.pattern = "\\S{6,12}";
    passwordInput.insertAdjacentHTML(
      "afterend",
      '<div class="form-text">Entre 6 y 12 caracteres, sin espacios.</div>',
    );

    function validatePassword() {
      const isValid = /^\S{6,12}$/.test(passwordInput.value);
      passwordInput.setCustomValidity(
        passwordInput.value && !isValid
          ? "La contraseña debe tener entre 6 y 12 caracteres y no puede contener espacios."
          : "",
      );
    }

    passwordInput.addEventListener("input", validatePassword);

    if (nameInput) {
      nameInput.maxLength = 19;
      nameInput.insertAdjacentHTML(
        "afterend",
        '<div class="form-text">Máximo 19 caracteres.</div>',
      );
      const validateName = () => {
        nameInput.setCustomValidity(
          nameInput.value && nameInput.value.trim().length === 0
            ? "Ingresa un nombre válido."
            : "",
        );
      };
      nameInput.addEventListener("input", validateName);
      form.addEventListener("submit", validateName);
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      validatePassword();
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      const isRegister = Boolean(form.closest("#registerPane"));
      bootstrap.Modal.getOrCreateInstance(
        document.getElementById("accountModal"),
      ).hide();
      form.reset();
      showMessage(
        isRegister
          ? "Cuenta creada correctamente."
          : "Sesión iniciada correctamente.",
      );
    });
  });

  document
    .querySelector(".contact-form")
    .addEventListener("submit", (event) => {
      event.preventDefault();
      if (!event.currentTarget.checkValidity()) {
        event.currentTarget.reportValidity();
        return;
      }

      bootstrap.Modal.getOrCreateInstance(
        document.getElementById("contactoModal"),
      ).hide();
      event.currentTarget.reset();
      showMessage("Consulta enviada correctamente.");
    });

  document.querySelectorAll("#mainNavbar .nav-link").forEach((link) => {
    link.addEventListener("click", () => {
      const navbar = document.getElementById("mainNavbar");
      const collapse = bootstrap.Collapse.getInstance(navbar);
      if (collapse) collapse.hide();
    });
  });

  document.querySelectorAll(".current-year").forEach((year) => {
    year.textContent = new Date().getFullYear();
  });

  renderCart();
});
