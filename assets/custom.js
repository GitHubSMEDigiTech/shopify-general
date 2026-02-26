/**
 * Include your custom JavaScript here.
 *
 * We also offer some hooks so you can plug your own logic. For instance, if you want to be notified when the variant
 * changes on product page, you can attach a listener to the document:
 *
 * document.addEventListener('variant:changed', function(event) {
 *   var variant = event.detail.variant; // Gives you access to the whole variant details
 * });
 *
 * You can also add a listener whenever a product is added to the cart:
 *
 * document.addEventListener('product:added', function(event) {
 *   var variant = event.detail.variant; // Get the variant that was added
 *   var quantity = event.detail.quantity; // Get the quantity that was added
 * });
 *
 * If you are an app developer and requires the theme to re-render the mini-cart, you can trigger your own event. If
 * you are adding a product, you need to trigger the "product:added" event, and make sure that you pass the quantity
 * that was added so the theme can properly update the quantity:
 *
 * document.documentElement.dispatchEvent(new CustomEvent('product:added', {
 *   bubbles: true,
 *   detail: {
 *     quantity: 1
 *   }
 * }));
 *
 * If you just want to force refresh the mini-cart without adding a specific product, you can trigger the event
 * "cart:refresh" in a similar way (in that case, passing the quantity is not necessary):
 *
 * document.documentElement.dispatchEvent(new CustomEvent('cart:refresh', {
 *   bubbles: true
 * }));
 */

/**
 * ==============================
 * Mini-Cart Related Products
 * ==============================
 * Popola automaticamente i prodotti correlati nel mini-cart
 * usando la Shopify Product Recommendations API per ogni line item.
 */
(function () {
  'use strict';

  var RELATED_PRODUCTS_LIMIT = 6; // numero max di prodotti correlati da mostrare
  var RECS_PER_PRODUCT = 10; // quanti chiederne all'API per prodotto (poi deduplica)
  var relatedCache = {};
  var variantCache = {};
  var productMetaCache = {};
  var lineItemsLoadingTimer = null;
  var lastKey = null;
  var isLoading = false;

  function setMiniCartLineItemsLoading(isLoadingState) {
    var lineItemsList = document.querySelector('#mini-cart .mini-cart__line-item-list');
    if (!lineItemsList) return;

    lineItemsList.classList.toggle('is-loading', !!isLoadingState);

    if (lineItemsLoadingTimer) {
      clearTimeout(lineItemsLoadingTimer);
      lineItemsLoadingTimer = null;
    }

    if (isLoadingState) {
      lineItemsLoadingTimer = setTimeout(function () {
        lineItemsList.classList.remove('is-loading');
        lineItemsLoadingTimer = null;
      }, 5000);
    }
  }

  function setMiniCartLineItemsMaxHeight() {
    var miniCart = document.getElementById('mini-cart');
    if (!miniCart) return;

    if (!window.matchMedia('(min-width: 641px)').matches) {
      miniCart.style.removeProperty('--mini-cart-recap-height');
      return;
    }

    var recap = miniCart.querySelector('.mini-cart__recap');
    if (!recap) return;

    var recapHeight = Math.ceil(recap.getBoundingClientRect().height || 0);
    if (recapHeight > 0) {
      miniCart.style.setProperty('--mini-cart-recap-height', recapHeight + 'px');
    }
  }

  /**
   * Carica i prodotti correlati per il mini-cart
   */
  function loadMiniCartRelatedProducts() {
    var container = document.querySelector('.mini-cart__related-products');
    if (!container) return;

    var listEl = container.querySelector('.mini-cart__related-list');
    if (!listEl) return;

    var idsString = container.getAttribute('data-cart-product-ids') || '';
    var handlesString = container.getAttribute('data-cart-product-handles') || '';
    var addToCartLabelText = container.getAttribute('data-add-to-cart-label') || '';
    var productIds = idsString.split(',').map(function (id) { return String(id || '').trim(); }).filter(Boolean);
    var cartProductHandles = new Set(handlesString.split(',').map(function (handle) { return String(handle || '').trim(); }).filter(Boolean));

    function loadFromCartAjax() {
      return fetch("".concat(window.routes.cartUrl, ".js"), {
        credentials: 'same-origin',
        headers: { 'Cache-Control': 'no-cache' }
      }).then(function (r) {
        return r.json();
      }).then(function (cart) {
        productIds = (cart.items || []).map(function (item) {
          return String(item.product_id || '').trim();
        }).filter(Boolean);
        cartProductHandles = new Set((cart.items || []).map(function (item) {
          return String(item.handle || '').trim();
        }).filter(Boolean));
      }).catch(function () {
        productIds = [];
      });
    }

    function parseRecommendationsFromHtml(html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var items = doc.querySelectorAll('.product-item, [data-product-item]');
      var products = [];

      items.forEach(function (item) {
        var linkEl = item.querySelector('a.product-item__image-wrapper, a.product-item__title, a[href*="/products/"]');
        var imgEl = item.querySelector('img.product-item__primary-image, img');
        var titleEl = item.querySelector('a.product-item__title, .product-item__title');
        var vendorEl = item.querySelector('.product-item__vendor, .product-meta__vendor');
        var priceEl = item.querySelector('.price');
        var href = linkEl ? linkEl.getAttribute('href') : '#';
        var imgSrc = imgEl ? (imgEl.getAttribute('data-src') || imgEl.getAttribute('src') || '') : '';
        var title = titleEl ? titleEl.textContent.trim() : (linkEl ? linkEl.textContent.trim() : '');
        var vendor = vendorEl ? vendorEl.textContent.trim() : '';
        var price = priceEl ? priceEl.innerHTML.trim() : '';
        var handleMatch = href.match(/\/products\/([^?#/]+)/);
        var handle = handleMatch ? handleMatch[1] : '';

        if (!handle) return;

        products.push({
          href: href,
          imgSrc: imgSrc,
          title: title,
          vendor: vendor,
          price: price,
          handle: handle
        });
      });

      return products;
    }

    function fetchRecommendationsJson(productId) {
      var url = window.routes.productRecommendationsUrl
        + '?product_id=' + encodeURIComponent(productId)
        + '&limit=' + RECS_PER_PRODUCT
        + '&intent=related';

      return fetch(url, {
        credentials: 'same-origin',
        headers: {
          'Accept': 'application/json',
          'Cache-Control': 'no-cache'
        }
      }).then(function (r) {
        if (!r.ok) return [];
        return r.json();
      }).then(function (data) {
        var products = Array.isArray(data && data.products) ? data.products : [];

        return products.map(function (p) {
          var handle = String(p.handle || '').trim();
          var image = p.featured_image || '';

          return {
            href: handle ? "/products/" + handle : '#',
            imgSrc: image,
            title: p.title || '',
            vendor: p.vendor || '',
            price: '',
            handle: handle
          };
        }).filter(function (p) { return !!p.handle; });
      }).catch(function () {
        return [];
      });
    }

    function fetchRecommendationsForProduct(productId) {
      var url = window.routes.productRecommendationsUrl
        + '?product_id=' + encodeURIComponent(productId)
        + '&limit=' + RECS_PER_PRODUCT
        + '&section_id=product-recommendations';

      return fetch(url, {
        credentials: 'same-origin',
        headers: { 'Cache-Control': 'no-cache' }
      }).then(function (r) {
        return r.text();
      }).then(function (html) {
        var parsed = parseRecommendationsFromHtml(html);
        if (parsed.length > 0) return parsed;
        return fetchRecommendationsJson(productId);
      }).catch(function () {
        return fetchRecommendationsJson(productId);
      });
    }

    function fetchFallbackProducts(excludedHandles) {
      var baseUrl = window.routes.rootUrl === '/' ? '' : window.routes.rootUrl;
      var url = "".concat(baseUrl, "/collections/all/products.json?limit=24");

      return fetch(url, {
        credentials: 'same-origin',
        headers: { 'Cache-Control': 'no-cache' }
      }).then(function (r) {
        if (!r.ok) return { products: [] };
        return r.json();
      }).then(function (data) {
        var products = Array.isArray(data && data.products) ? data.products : [];

        return products.map(function (p) {
          var handle = String(p.handle || '').trim();
          var image = p.image && p.image.src ? p.image.src : '';

          return {
            href: handle ? "/products/" + handle : '#',
            imgSrc: image,
            title: p.title || '',
            vendor: p.vendor || '',
            price: '',
            handle: handle
          };
        }).filter(function (p) {
          return p.handle && !excludedHandles.has(p.handle);
        });
      }).catch(function () {
        return [];
      });
    }

    var dataReady = productIds.length > 0 ? Promise.resolve() : loadFromCartAjax();

    dataReady.then(function () {
      if (productIds.length === 0) {
        container.style.display = 'none';
        return;
      }

      var key = productIds.join(',');
      if (relatedCache[key]) {
        container.style.display = '';
        listEl.innerHTML = relatedCache[key];
        return;
      }

      if (isLoading && key === lastKey) return;
      isLoading = true;
      lastKey = key;
      listEl.innerHTML = '<div class="mini-cart__related-loader"><span class="mini-cart__spinner" aria-hidden="true"></span></div>';
      container.style.display = '';

      // Fetch raccomandazioni per ogni prodotto in parallelo
      var fetches = productIds.map(function (productId) {
        return fetchRecommendationsForProduct(productId);
      });

      Promise.all(fetches).then(function (results) {
        var allProducts = [];
        var perProductLimit = Math.max(1, Math.floor(RELATED_PRODUCTS_LIMIT / productIds.length));
        var remainder = RELATED_PRODUCTS_LIMIT - perProductLimit * productIds.length;

        // Filtra e deduplica per singolo prodotto
        var filteredByProduct = results.map(function (products) {
          var filtered = [];
          var perProductSeen = new Set();

          products.forEach(function (p) {
            if (!cartProductHandles.has(p.handle) && p.handle && !perProductSeen.has(p.handle)) {
              perProductSeen.add(p.handle);
              filtered.push(p);
            }
          });

          return filtered;
        });

        var quotas = filteredByProduct.map(function () { return perProductLimit; });

        for (var i = 0; i < remainder; i += 1) {
          quotas[i % quotas.length] += 1;
        }

        // Alterna i prodotti tra le liste
        var round = 0;
        var hasMore = true;

        while (allProducts.length < RELATED_PRODUCTS_LIMIT && hasMore) {
          hasMore = false;

          for (var listIndex = 0; listIndex < filteredByProduct.length; listIndex += 1) {
            var list = filteredByProduct[listIndex];

            if (round < quotas[listIndex] && list[round]) {
              allProducts.push(list[round]);
              hasMore = true;
            }

            if (allProducts.length >= RELATED_PRODUCTS_LIMIT) {
              break;
            }
          }

          round += 1;
        }

        function renderProducts(productsToRender) {
          if (productsToRender.length === 0) {
            container.style.display = 'none';
            listEl.innerHTML = '';
            isLoading = false;
            return;
          }

          Promise.all(productsToRender.map(function (p) {
          if (!p.vendor || !p.vendor.trim()) {
            return getProductMetaByHandle(p.handle).then(function (meta) {
              return {
                href: p.href,
                imgSrc: p.imgSrc,
                title: p.title,
                vendor: p.vendor && p.vendor.trim() ? p.vendor : meta.vendor,
                price: p.price,
                handle: p.handle
              };
            });
          }

          return Promise.resolve(p);
          })).then(function (enrichedProducts) {
            var html = enrichedProducts.map(function (p) {
              var displayPrice = String(p.price || '').replace(/\s*EUR\b/gi, '').trim();

              return '<div class="mini-cart__related-item">'
                + '<a href="' + p.href + '" class="mini-cart__related-link">'
                + '<div class="mini-cart__related-image">'
                + '<img src="' + p.imgSrc.replace(/\{width\}/g, '200') + '" alt="' + escapeHtml(p.title) + '" loading="lazy" width="100" height="100">'
                + '</div>'
                + '<span class="mini-cart__product-vendor">' + escapeHtml(p.vendor || '') + '</span>'
                + '<span class="mini-cart__product-title text--strong">' + escapeHtml(p.title) + '</span>'
                + '<div class="mini-cart__price-list"><span class="price">' + displayPrice + '</span></div>'
                + '</a>'
                  + '<a href="#" class="mini-cart__related-add link" data-handle="' + p.handle + '">' + escapeHtml(addToCartLabelText) + '</a>'
                + '</div>';
            }).join('');

            relatedCache[key] = html;
            container.style.display = '';
            listEl.innerHTML = html;
            isLoading = false;
          }).catch(function () {
            isLoading = false;
          });
        }

        // Limita al massimo configurato
        allProducts = allProducts.slice(0, RELATED_PRODUCTS_LIMIT);

        if (allProducts.length > 0) {
          renderProducts(allProducts);
          return;
        }

        fetchFallbackProducts(cartProductHandles).then(function (fallbackProducts) {
          renderProducts(fallbackProducts.slice(0, RELATED_PRODUCTS_LIMIT));
        });
      }).catch(function () {
        isLoading = false;
      });
    });
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function getVariantIdByHandle(handle) {
    if (!handle) return Promise.resolve(null);
    if (variantCache[handle]) return Promise.resolve(variantCache[handle]);

    var baseUrl = window.routes.rootUrl === '/' ? '' : window.routes.rootUrl;
    var url = "".concat(baseUrl, "/products/").concat(handle, ".js");

    return fetch(url, {
      credentials: 'same-origin',
      headers: { 'Cache-Control': 'no-cache' }
    }).then(function (r) {
      return r.json();
    }).then(function (product) {
      if (!product || !product.variants || !product.variants.length) return null;
      var variant = product.variants.find(function (v) { return v.available; }) || product.variants[0];
      variantCache[handle] = variant.id;
      return variant.id;
    }).catch(function () {
      return null;
    });
  }

  function getProductMetaByHandle(handle) {
    if (!handle) return Promise.resolve({ vendor: '' });
    if (productMetaCache[handle]) return Promise.resolve(productMetaCache[handle]);

    var baseUrl = window.routes.rootUrl === '/' ? '' : window.routes.rootUrl;
    var url = "".concat(baseUrl, "/products/").concat(handle, ".js");

    return fetch(url, {
      credentials: 'same-origin',
      headers: { 'Cache-Control': 'no-cache' }
    }).then(function (r) {
      return r.json();
    }).then(function (product) {
      var meta = {
        vendor: product && product.vendor ? product.vendor : ''
      };

      productMetaCache[handle] = meta;
      return meta;
    }).catch(function () {
      return { vendor: '' };
    });
  }

  // Carica al DOMContentLoaded
  document.addEventListener('DOMContentLoaded', function () {
    setMiniCartLineItemsMaxHeight();
    loadMiniCartRelatedProducts();
  });

  // In alcuni template il mini-cart viene inizializzato solo quando si apre:
  // ricarico i related anche al toggle del drawer.
  document.addEventListener('click', function (event) {
    var toggleButton = event.target.closest('[data-action="toggle-mini-cart"]');
    if (!toggleButton) return;

    setTimeout(function () {
      setMiniCartLineItemsMaxHeight();
      loadMiniCartRelatedProducts();
    }, 80);
  });

  // Gestisce anche il restore da cache del browser (back/forward).
  window.addEventListener('pageshow', function () {
    setMiniCartLineItemsMaxHeight();
    loadMiniCartRelatedProducts();
  });

  window.addEventListener('resize', setMiniCartLineItemsMaxHeight);

  // Add-to-cart rapido dai prodotti correlati
  document.addEventListener('click', function (event) {
    var navButton = event.target.closest('.mini-cart__related-arrow');
    if (navButton) {
      event.preventDefault();
      event.stopPropagation();

      var relatedBlock = navButton.closest('.mini-cart__related-products');
      var list = relatedBlock ? relatedBlock.querySelector('.mini-cart__related-list') : null;

      if (list) {
        var direction = navButton.getAttribute('data-direction') === 'prev' ? -1 : 1;
        var amount = Math.round(list.clientWidth * 0.66);
        list.scrollBy({ left: direction * amount, behavior: 'smooth' });
      }

      return;
    }

    var button = event.target.closest('.mini-cart__related-add');
    if (!button) return;

    event.preventDefault();
    event.stopPropagation();

    if (button.hasAttribute('disabled')) return;
    button.setAttribute('disabled', 'disabled');
    button.classList.add('is-loading');
    button.setAttribute('aria-busy', 'true');
    setMiniCartLineItemsLoading(true);

    var handle = button.getAttribute('data-handle');

    getVariantIdByHandle(handle).then(function (variantId) {
      if (!variantId) {
        button.removeAttribute('disabled');
        button.classList.remove('is-loading');
        button.removeAttribute('aria-busy');
        setMiniCartLineItemsLoading(false);
        return null;
      }

      return fetch("".concat(window.routes.cartAddUrl, ".js"), {
        body: JSON.stringify({ id: variantId, quantity: 1 }),
        credentials: 'same-origin',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        }
      });
    }).then(function (response) {
      if (response && response.ok) {
        document.documentElement.dispatchEvent(new CustomEvent('product:added', {
          bubbles: true,
          detail: { quantity: 1 }
        }));
      }
      button.removeAttribute('disabled');
      button.classList.remove('is-loading');
      button.removeAttribute('aria-busy');
    }).catch(function () {
      button.removeAttribute('disabled');
      button.classList.remove('is-loading');
      button.removeAttribute('aria-busy');
      setMiniCartLineItemsLoading(false);
    });
  });

  // Ricarica quando il carrello viene aggiornato (re-render)
  document.addEventListener('cart:refresh', function () {
    setMiniCartLineItemsMaxHeight();
    setMiniCartLineItemsLoading(false);
    loadMiniCartRelatedProducts();
  });

  // L'evento cart:rerendered viene emesso sul bottone carrello (non bubble)
  var cartEl = document.querySelector('.header__action-item--cart');
  if (cartEl) {
    cartEl.addEventListener('cart:rerendered', function () {
      setMiniCartLineItemsMaxHeight();
      setMiniCartLineItemsLoading(false);
      loadMiniCartRelatedProducts();
    });
  }
})();