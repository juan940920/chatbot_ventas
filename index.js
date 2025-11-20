const { makeWASocket, useMultiFileAuthState, Browsers, DisconnectReason, fetchLatestBaileysVersion, delay } = require('baileys');
const QRCode = require('qrcode-terminal');
const qrcode = require('qrcode');
const axios = require('axios');
const express = require('express');
require('dotenv').config();

const { createContactIfNotExists, getProductos, registrarPedido, actualizarStock, getEmpresaInfo } = require('./sheets');

const app = express();
app.use(express.json());

// --- VARIABLES GLOBALES ---
let latestQR = ''; // Variable para almacenar el QR más reciente
let empresaInfo = {}; // Variable para almacenar la info de la empresa
let sock; // Variable global para el socket
const userContext = {}; // Contexto de cada usuario

// Iniciar el servidor en un puerto (ej. 3000)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor HTTP para Baileys escuchando en el puerto ${PORT}`);
    console.log(`Accede a http://localhost:${PORT}/qr para escanear el código QR`);
});

// --- RUTA PARA MOSTRAR EL QR ---
app.get('/qr', (req, res) => {
    if (latestQR) {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head><title>Escanea el QR para WhatsApp</title>
                <style>body { font-family: Arial; background: #f0f2f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                    .container { text-align: center; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
                    h1 { color: #128C7E; } img { max-width: 300px; border: 5px solid #128C7E; border-radius: 10px; } p { color: #555; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Escanea este código QR con WhatsApp</h1>
                    <img src="${latestQR}" alt="Código QR de WhatsApp">
                    <p>Abre WhatsApp > Menu > Dispositivos Vinculados > Vincular un dispositivo</p>
                </div>
            </body>
            </html>
        `);
    } else {
        res.status(404).send('El código QR aún no se ha generado. Por favor, espera...');
    }
});

// --- FUNCIÓN DE CONEXIÓN A WHATSAPP ---
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({
        version,
        browser: Browsers.windows('Chrome'),
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: true
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrcode.toDataURL(qr, (err, url) => {
                if (err) { console.error("Error al generar el QR:", err); return; }
                latestQR = url;
                console.log("¡Código QR generado! Escanéalo en: http://localhost:" + PORT + "/qr");
            });
            QRCode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('Conexión cerrada, reconectando...');
                latestQR = '';
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log("¡CONEXIÓN ABIERTA!");
            latestQR = '';
        }
    });

    // --- LÓGICA DE MENSAJES ---
    sock.ev.on("messages.upsert", async (event) => {
        for (const m of event.messages) {
            const id = m.key.remoteJid;
            const nombre = m.pushName;
            
            if(event.type != 'notify' || m.key.fromMe || id.includes('@g.us') || id.includes('@broadcast')) return;
        
            let mensaje = (m.message?.conversation || m.message?.extendedTextMessage?.text || "").toUpperCase();
            console.log(`[${id}] Mensaje recibido: ${mensaje}`);

            // --- NUEVO: COMPROBACIÓN PARA VOLVER AL MENÚ PRINCIPAL ---
            if (mensaje === 'MENU' || mensaje === 'SALIR') {
                userContext[id].menuActual = "main";
                await enviarMenu(sock, id, "main", nombre);
                return; // Detenemos el procesamiento de este mensaje
            }

            await sock.readMessages([m.key]);
            await delay(100);
            await sock.sendPresenceUpdate("composing", id);
            await delay(400);
            
            await createContactIfNotExists(id, nombre);
            
            if(!userContext[id]){
                userContext[id] = { menuActual: "main" };
                await enviarMenu(sock, id, "main", nombre);
                return;
            }

            const menuActual = userContext[id].menuActual;
            const menu = menuData[menuActual];
            const opcionSelecionada = menu.options[mensaje];

            // 1. MANEJAR NAVEGACIÓN A SUBMENÚS
            if (opcionSelecionada && opcionSelecionada.submenu) {
                userContext[id].menuActual = opcionSelecionada.submenu;
                await enviarMenu(sock, id, opcionSelecionada.submenu);
                return;
            }

            // 2. MANEJAR BÚSQUEDA DE PRODUCTOS
            if (menuActual === "buscar_producto") {
                const respuesta = await conectarConOpenAI(mensaje, id);
                await sock.sendMessage(id, { text: respuesta });
                return;
            }
            
            // 3. MANEJAR RESPUESTAS DINÁMICAS DEL MENÚ PRINCIPAL
            let respuestaFinal = null;
            if (menuActual === 'main' && opcionSelecionada) {
                const opcionKey = mensaje; // 'A', 'B', 'C', etc.
                switch (opcionKey) {
                    case 'B': // Ubicación
                        respuestaFinal = {
                            tipo: "text",
                            msg: `📍 *Nuestra Dirección*\n${empresaInfo.direccion || 'Dirección no disponible'}\n\n🗺️ *Ver en Google Maps:*\n${empresaInfo.enlaces_maps || 'Link no disponible'}`
                        };
                        break;
                    case 'C': // Horarios
                        respuestaFinal = {
                            tipo: "text",
                            msg: `⏰ *NUESTRO HORARIO DE ATENCIÓN*\n\n${empresaInfo.horario || 'No definido'}\n\n*¡Te esperamos!* 🛍️`
                        };
                        break;
                    case 'D': // Contacto
                        respuestaFinal = {
                            tipo: "text",
                            msg: `📞 *INFORMACIÓN DE CONTACTO*\n\n📱 *WHATSAPP*\n${empresaInfo.contacto_whatsapp || 'No disponible'}\n\n📧 *EMAIL*\n${empresaInfo.correo_electronico || 'No disponible'}\n\n🌐 *PÁGINA WEB*\n${empresaInfo.contacto_web || 'No disponible'}\n\n*Estamos para servirte* 💼`
                        };
                        break;
                    case 'E': // Catalogo
                        const catalogoUrl = empresaInfo.catalogo_url;
                        const catalogoNombre = empresaInfo.catalogo_nombre || "catalogo.pdf";

                        if (catalogoUrl) {
                            await sock.sendMessage(id, {
                                document: { url: catalogoUrl },
                                fileName: catalogoNombre,
                                caption: "📄 *Aquí tienes nuestro catálogo completo.*\n\nDescárgalo para ver todos nuestros productos y sus detalles."
                            });
                        } else {
                            await sock.sendMessage(id, { text: "❌ Lo sentimos, el catálogo no está disponible en este momento." });
                        }
                        return;
                }
            }

            if (respuestaFinal) {
                await sock.sendMessage(id, { [respuestaFinal.tipo]: respuestaFinal.msg });
            } else if (menuActual === 'main' && !opcionSelecionada) {
                await sock.sendMessage(id, {text: "Por favor, elige una opción del menú"});
            }
        }
    });
}

// --- FUNCIÓN DE INICIALIZACIÓN DE LA APLICACIÓN ---
async function initializeApp() {
    console.log("Cargando configuración desde Google Sheets...");
    empresaInfo = await getEmpresaInfo();
    if (Object.keys(empresaInfo).length === 0) {
        console.warn("ADVERTENCIA: No se pudo cargar la información de la empresa. Se usarán valores por defecto.");
    }
    console.log("Configuración cargada. Iniciando conexión a WhatsApp...");
    connectToWhatsApp();
}

// --- FUNCIÓN PARA ENVIAR MENÚS ---
async function enviarMenu(sock, id, menuKey, nombre) {
    let menuMensaje = '';
    console.log("nombre nombre nombre: ", id);
    
    
    if (menuKey === 'main') {
        const nombreEmpresa = empresaInfo.nombre || '[Nombre de la empresa]';
        const bienvenida = `¡Hola ${nombre}, bienvenido a *${nombreEmpresa}*! \nTu destino para las mejores ofertas tecnológicas:`;
        
        const optionText = Object.entries(menuData[menuKey].options)
                                    .map(([key, option]) => `- 👉 *${key}*: ${option.text}`)
                                    .join("\n");
        
        menuMensaje = `${bienvenida}\n\n${optionText}\n\n> *Escribe una opción!*`;
    } else {
        const menu = menuData[menuKey];
        const optionText = Object.entries(menu.options)
                                    .map(([key, option]) => `- 👉 *${key}*: ${option.text}`)
                                    .join("\n");
        menuMensaje = `${menu.mensaje}\n\n${optionText}\n\n> *Escribe una opción!*`;
    }

    await sock.sendMessage(id, {text: menuMensaje});
}

// --- ESTRUCTURA DE MENÚS (SIMPLIFICADA) ---
const menuData = {
    main: {
        options: {
            A: { text: "🔥 OFERTAS - Ver productos", submenu: "buscar_producto" },
            B: { text: "📍 UBICACIÓN - ¿Dónde encontramos?" },
            C: { text: "🕘 HORARIOS - ¿Cuándo atendemos?" },
            D: { text: "📞 CONTACTO - Hablemos" },
            E: { text: "🔍 CATÁLOGO - ver productos" },
        }
    },
    buscar_producto: {
        mensaje: `Estoy aquí para ayudarte a encontrar el producto perfecto.
Solo dime qué buscas. Puedes ser tan específico como quieras:
• "celular Honor"
• "laptop para trabajo"
• "audífonos hasta $50"
---
🤖 **Mis comandos son:**
   \`agregar [número producto], cantidad [número]\` -> Añade al carrito.
   \`finalizar\` o \`terminar\` -> Termina tu compra.
   \`menu\` o \`salir\` -> Vuelve al menú principal.`,
        options: {}
    }
};

// La función conectarConOpenAI y el resto de tu código permanecen igual.
// ... (Pega aquí tu función conectarConOpenAI completa) ...

async function conectarConOpenAI(mensaje, id) {
    const TOKEN = process.env.OPENAI_API_KEY; 
    
    const mensajeLower = mensaje.toLowerCase().trim();
    console.log(`[DEBUG] Mensaje recibido de ${id}: "${mensaje}"`);

    try {
        if (!userContext[id]?.carrito) {
            userContext[id] = userContext[id] || {};
            userContext[id].carrito = [];
        }

        if (mensajeLower.includes("agregar") || mensajeLower.includes("llevar")) {
            console.log("[DEBUG] Entrando en la lógica de AGREGAR.");
            if (!userContext[id]?.productosRecientes || userContext[id].productosRecientes.length === 0) {
                return "Primero busca un producto para poder agregarlo al carrito.";
            }
            const productos = userContext[id].productosRecientes;
            const numerosEnMensaje = mensaje.match(/\d+/g);
            if (!numerosEnMensaje || numerosEnMensaje.length === 0) {
                return "❌ No entendí qué producto quieres agregar. Por favor, indica el número del producto. Ejemplo: `agregar 3`";
            }
            const productoIndex = parseInt(numerosEnMensaje[0]) - 1;
            if (productoIndex < 0 || productoIndex >= productos.length) {
                return `❌ Número de producto no válido. Elige un número entre 1 y ${productos.length}.`;
            }
            let cantidad = 1;
            if (numerosEnMensaje.length > 1) {
                cantidad = parseInt(numerosEnMensaje[1]);
            }
            const cantidadConPalabra = mensajeLower.match(/cantidad\s+(\d+)/);
            if (cantidadConPalabra) {
                cantidad = parseInt(cantidadConPalabra[1]);
            }
            const productoSeleccionado = productos[productoIndex];
            const stockActual = parseInt(productoSeleccionado.Stock);
            if (cantidad > stockActual) {
                return `⚠️ Stock insuficiente. Disponibles: ${stockActual} unidades de "${productoSeleccionado.Nombre_Producto}".\n\nIntenta con una cantidad menor.`;
            } else {
                const itemCarrito = {
                    ID_Producto: productoSeleccionado.ID_Producto,
                    Nombre: productoSeleccionado.Nombre_Producto,
                    Stock: productoSeleccionado.Stock,
                    Cantidad: cantidad,
                    PrecioUnitario: parseFloat(productoSeleccionado.Precio)
                };
                const existingItem = userContext[id].carrito.find(item => item.ID_Producto === productoSeleccionado.ID_Producto);
                if (existingItem) {
                    existingItem.Cantidad += cantidad;
                } else {
                    userContext[id].carrito.push(itemCarrito);
                }
                const confirmacion = `✅ Agregado al carrito: ${cantidad} x ${productoSeleccionado.Nombre_Producto} - $${productoSeleccionado.Precio}`;
                const resumenCarrito = userContext[id].carrito.map(item => {
                    const subtotal = item.Cantidad * item.PrecioUnitario;
                    return `• ${item.Nombre} (x${item.Cantidad}) - $${subtotal.toFixed(2)}`;
                }).join('\n');
                const totalCarrito = userContext[id].carrito.reduce((total, item) => {
                    return total + (item.Cantidad * item.PrecioUnitario);
                }, 0);
                const respuestaFinal = `${confirmacion}\n\n` +
                                    `🛒 *Tu carrito ahora:*\n` +
                                    `${resumenCarrito}\n\n` +
                                    `💰 *Total a pagar: $${totalCarrito.toFixed(2)}*\n\n` +
                                    `Puedes seguir comprando o escribe \`finalizar\` para tu pedido.`;
                return respuestaFinal;
            }
        }

        if (mensajeLower.includes("finalizar") || mensajeLower.includes("terminar")) {
            console.log("[DEBUG] Entrando en la lógica de FINALIZAR.");
            if (userContext[id].carrito.length === 0) {
                return "⚠️ Tu carrito está vacío. Agrega productos antes de finalizar.";
            } else {
                const total = userContext[id].carrito.reduce((sum, item) => sum + (item.Cantidad * item.PrecioUnitario), 0);
                const pedido = {
                    ID_Pedido: Date.now().toString(),
                    Timestamp: new Date().toISOString(),
                    ID_Cliente: id,
                    carrito: userContext[id].carrito,
                    Estado: "Pendiente"
                };
                const registrado = await registrarPedido(pedido);
                if (registrado) {
                    for (const item of userContext[id].carrito) {
                        const nuevoStock = parseInt(item.Stock) - item.Cantidad;
                        await actualizarStock(item.ID_Producto, nuevoStock); 
                    }
                    const respuestaFinal = `✅ Pedido registrado! ID: ${pedido.ID_Pedido}\n💰 Total: $${total.toFixed(2)}\n📦 Productos: ${userContext[id].carrito.length}`;
                    userContext[id].carrito = [];
                    return respuestaFinal;
                } else {
                    return "❌ Error al registrar el pedido.";
                }
            }
        }
        
        if (!userContext[id]?.list_mensajes) {
            userContext[id].list_mensajes = [
                {
                    "role": "system",
                    // --- INICIO DEL PROMPT MODIFICADO CON PRECIO ---
                    "content": `Eres un experto en ventas especializado en la búsqueda de productos. Tu ÚNICA y EXCLUSIVA función es analizar las solicitudes de los clientes para encontrar productos. NO eres un asistente general. NO respondes preguntas sobre otros temas, NO mantienes conversaciones y NO inventes información.

                    REGLA FUNDAMENTAL: Si el mensaje del usuario NO es una búsqueda de producto (por ejemplo, un saludo, una pregunta personal, un comentario, etc.), NO debes intentar ayudar. Debes indicar que no entendiste la solicitud relacionada con productos.

                    INSTRUCCIONES DE BÚSQUEDA (solo si aplica):

                    1.  **OBJETIVO PRINCIPAL: Identificar el Producto, su Categoría y su Precio Máximo.**
                        Tu tarea es extraer el nombre específico del producto, su categoría y el precio máximo si se menciona.

                    2.  **EXTRAE \`nombre_producto\`:**
                        Identifica el nombre del producto, la marca o el modelo específico mencionado. Ignora las palabras genéricas de categoría y las referencias a precio.
                        *   Ejemplo: En "quiero un celular honor", el nombre del producto es "honor".

                    3.  **EXTRAE \`categoria\`:**
                        Identifica la categoría del producto buscando palabras clave específicas en la solicitud.
                        *   **Lista de categorías conocidas:** "celular", "smartphone", "laptop", "computadora", "notebook", "tablet", "audífonos", "auriculares", "televisor", "smart tv", "smartwatch", "reloj inteligente", "parlante", "bocina", "consola", "videojuego".

                    4.  **EXTRAE \`precio_maximo\`:**
                        Identifica el límite de precio que el usuario está dispuesto a pagar. Busca frases como "de menos de", "hasta", "por debajo de", "más o menos", "alrededor de", "cerca de", seguidas de un número y un símbolo de moneda (opcional). Extrae SOLO el valor numérico.
                        *   Ejemplo: En "un celular de mas o menos 1000$", el precio máximo es 1000.
                        *   Ejemplo: En "laptops hasta 500 dolares", el precio máximo es 500.
                        *   Si no se menciona un límite de precio, el valor debe ser null.

                    5.  **EXTRAE INFORMACIÓN ADICIONAL (solo con palabras clave explícitas):**
                        Extrae la información adicional ÚNICAMENTE si el cliente usa las palabras clave explícitas.
                        *   Si el cliente dice la palabra **"marca"**, extrae lo que sigue.
                        *   Si el cliente dice la palabra **"modelo"**, extrae lo que sigue.

                    FORMATO DE SALIDA OBLIGATORIO:
                    Responde ÚNICAMENTE con un objeto JSON que tenga esta estructura exacta.
                    {
                        "nombre_producto": "el nombre específico del producto o null",
                        "categoria": "la categoría identificada o null",
                        "precio_maximo": "el precio máximo numérico o null",
                        "marca": "la marca (solo si se usa la palabra clave) o null",
                        "modelo": "el modelo (solo si se usa la palabra clave) o null",
                        "respuesta_breve": "una confirmación de búsqueda o un mensaje de no entendido, en 15 palabras máximo"
                    }

                    EJEMPLOS DE BÚSQUEDA VÁLIDA:
                    - Entrada: "quiero un celular de mas o menos 1000$ que me ofreces"
                    - Salida: { "nombre_producto": null, "categoria": "celular", "precio_maximo": 1000, "marca": null, "modelo": null, "respuesta_breve": "Buscando celulares de hasta 1000 para ti." }

                    - Entrada: "necesito una laptop dell inspiron"
                    - Salida: { "nombre_producto": "dell inspiron", "categoria": "laptop", "precio_maximo": null, "marca": null, "modelo": null, "respuesta_breve": "Buscando laptops Dell Inspiron para ti." }

                    - Entrada: "audífonos por debajo de 50"
                    - Salida: { "nombre_producto": null, "categoria": "audífonos", "precio_maximo": 50, "marca": null, "modelo": null, "respuesta_breve": "Mostrando audífonos con precios menores a 50." }

                    EJEMPLOS DE CONSULTA INVÁLIDA (FUERA DE TEMA):
                    - Entrada: "¿Qué tiempo hace hoy?"
                    - Salida: { "nombre_producto": null, "categoria": null, "precio_maximo": null, "marca": null, "modelo": null, "respuesta_breve": "No entendí tu solicitud. Por favor, dime qué producto buscas." }`
                    // --- FIN DEL PROMPT MODIFICADO ---
                }
            ];
        }

        userContext[id].list_mensajes.push({ "role": "user", "content": mensaje });

        const { data } = await axios.post("https://api.openai.com/v1/chat/completions", {
            "model": "gpt-3.5-turbo-1106",
            "messages": userContext[id].list_mensajes,
            "response_format": { "type": "json_object" },
            "temperature": 0.1
        }, {
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + TOKEN }
        });

        const filtrosIA = JSON.parse(data.choices[0].message.content);
        userContext[id].list_mensajes.push({ "role": "assistant", "content": JSON.stringify(filtrosIA) });

        console.log("este son los filtros de IA" , filtrosIA);
        

        if (!filtrosIA.categoria && !filtrosIA.nombre_producto && !filtrosIA.marca && !filtrosIA.modelo && !filtrosIA.precio_maximo) {
            return filtrosIA.respuesta_breve || "No entendí tu búsqueda. ¿Puedes darme más detalles sobre el producto que buscas?";
        }

        const filtrosBusqueda = {
            categoria: filtrosIA.categoria,
            nombre: filtrosIA.nombre_producto,
            marca: filtrosIA.marca,
            modelo: filtrosIA.modelo,
            precio_maximo: filtrosIA.precio_maximo,
            conStock: true,
            limite: 10
        };

        const productosEncontrados = await getProductos(filtrosBusqueda);
        console.log(`Productos encontrados: ${productosEncontrados.length}`);
        userContext[id].productosRecientes = productosEncontrados;

        if (productosEncontrados.length === 0) {
            return `${filtrosIA.respuesta_breve}\n\nNo encontré productos que coincidan con tu búsqueda.`;
        }

        const resumenProductos = productosEncontrados.map((p, i) => {
            let infoAdicional = "";
            if (p.Marca) infoAdicional += ` Marca: ${p.Marca}`;
            if (p.Modelo) infoAdicional += `, Modelo: ${p.Modelo}`;
            if (p.URL_Imagen) infoAdicional += `, Modelo: ${p.URL_Imagen}`;
            return `👉 ${i + 1}. ${p.Nombre_Producto} - $${p.Precio} (Stock: ${p.Stock} ${p.Unidad_Medida})${infoAdicional ? ` [${infoAdicional}]` : ''}`;
        }).join('\n');

        let respuestaFinal = `${filtrosIA.respuesta_breve}\n\n${resumenProductos}\n\n`;
        respuestaFinal += `Escribe *\`agregar 2, cantidad 10\`* para añadir al carrito o escribe \`finalizar\` para finalizar tu pedido.`;

        return respuestaFinal;

    } catch (error) {
        console.error("Error en conectarConOpenAI:", error);
        return "Lo siento, ocurrió un error al procesar tu solicitud.";
    }
}


// --- INICIO DE LA APLICACIÓN ---
initializeApp();