const { 
    makeWASocket, 
    useMultiFileAuthState, 
    Browsers, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    delay 
} = require('baileys');
const QRCode = require('qrcode-terminal');
const qrcode = require('qrcode');
const axios = require('axios');
const express = require('express');
require('dotenv').config();

const { 
    createContactIfNotExists, 
    getProductos, 
    registrarPedido, 
    actualizarStock, 
    getEmpresaInfo 
} = require('./sheets');

const app = express();
app.use(express.json());

// --- VARIABLES GLOBALES ---
let latestQR = '';
let empresaInfo = {};
let sock = null;
const userContext = new Map();

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
    console.log(`Escanea el QR en: http://localhost:${PORT}/qr`);
});

// --- RUTA QR ---
app.get('/qr', (req, res) => {
    if (latestQR) {
        res.send(`
            <!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="utf-8">
                <title>WhatsApp Bot - Escanear QR</title>
                <style>
                    body {font-family: Arial; background: #f0f2f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;}
                    .box {text-align: center; background: white; padding: 30px; border-radius: 15px; box-shadow: 0 8px 25px rgba(0,0,0,0.15);}
                    h1 {color: #128C7E;}
                    img {max-width: 320px; border: 6px solid #128C7E; border-radius: 12px; margin: 20px 0;}
                    p {color: #555; line-height: 1.5;}
                </style>
            </head>
            <body>
                <div class="box">
                    <h1>Escanea este código QR</h1>
                    <img src="${latestQR}" alt="QR WhatsApp">
                    <p>WhatsApp → Menú → Dispositivos vinculados → Vincular dispositivo</p>
                    <small>Se actualizará automáticamente...</small>
                </div>
                <script>setTimeout(()=>location.reload(), 15000)</script>
            </body>
            </html>
        `);
    } else {
        res.send('<h2>Generando QR... espera un momento</h2><script>setTimeout(()=>location.reload(), 3000)</script>');
    }
});

// --- CONEXIÓN A WHATSAPP ---
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        browser: Browsers.windows('Chrome'),
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.toDataURL(qr, (err, url) => {
                if (!err) {
                    latestQR = url;
                    console.log(`QR listo → http://localhost:${PORT}/qr`);
                }
            });
            QRCode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log('Reconectando en 5 segundos...');
                setTimeout(connectToWhatsApp, 5000);
            } else {
                console.log('Sesión cerrada. Borra la carpeta "auth_info_baileys" y vuelve a escanear.');
            }
        } else if (connection === 'open') {
            console.log('¡Conectado a WhatsApp correctamente!');
            latestQR = '';
        }
    });

    // --- RECEPCIÓN DE MENSAJES ---
    sock.ev.on('messages.upsert', async (event) => {
        if (event.type !== 'notify') return;

        for (const m of event.messages) {
            if (m.key.fromMe || m.key.remoteJid.endsWith('@g.us') || m.key.remoteJid.includes('@broadcast')) continue;

            const id = m.key.remoteJid;
            const nombre = m.pushName || 'Cliente';
            const mensajeRaw = (m.message?.conversation || m.message?.extendedTextMessage?.text || '').trim();
            const mensaje = mensajeRaw.toUpperCase().trim();

            console.log(`[${id}] ${nombre}: ${mensajeRaw}`);

            await sock.readMessages([m.key]);
            await sock.sendPresenceUpdate('composing', id);
            await delay(600);

            // Inicializar contexto
            if (!userContext.has(id)) {
                userContext.set(id, {
                    menuActual: 'main',
                    carrito: [],
                    productosRecientes: [],
                    list_mensajes: []
                });
            }
            const ctx = userContext.get(id);

            // Comando universal
            if (['MENU', 'MENÚ', 'SALIR', 'CANCELAR'].includes(mensaje)) {
                ctx.menuActual = 'main';
                ctx.carrito = [];
                ctx.productosRecientes = [];
                ctx.list_mensajes = [];
                await enviarMenu(sock, id, 'main', nombre);
                continue;
            }

            await createContactIfNotExists(id.replace('@s.whatsapp.net', ''), nombre);

            // Menú principal
            if (ctx.menuActual === 'main') {
                const opcion = menuData.main.options[mensaje];
                if (!opcion) {
                    await sock.sendMessage(id, { text: "❌ Opción no válida.\nEscribe *MENU* para ver las opciones disponibles." });
                    continue;
                }

                if (opcion.submenu) {
                    ctx.menuActual = opcion.submenu;
                    await enviarMenu(sock, id, opcion.submenu, nombre);
                } else {
                    await manejarOpcionRapida(sock, id, mensaje);
                }
                continue;
            }

            // Submenú de búsqueda
            if (ctx.menuActual === 'buscar_producto') {
                const respuesta = await conectarConOpenAI(mensajeRaw.toLowerCase(), id);
                await sock.sendMessage(id, { text: respuesta });
                continue;
            }
        }
    });
}

// --- OPCIONES RÁPIDAS ---
async function manejarOpcionRapida(sock, id, opcionKey) {
    let texto = '';

    switch (opcionKey) {
        case 'B':
            texto = `📍 *Nuestra Ubicación*\n\n${empresaInfo.direccion || 'No disponible'}\n\n🗺️ Ver en Maps:\n${empresaInfo.enlaces_maps || 'Link no disponible'}`;
            break;
        case 'C':
            texto = `⏰ *Horarios de Atención*\n\n${empresaInfo.horario || 'Lun-Vie 9:00-18:00 | Sáb 9:00-13:00'}\n\n¡Te esperamos!`;
            break;
        case 'D':
            texto = `📞 *Información de Contacto*\n\n📱 WhatsApp: ${empresaInfo.contacto_whatsapp || 'Este número'}\n📧 Email: ${empresaInfo.correo_electronico || 'No disponible'}\n🌐 Web: ${empresaInfo.contacto_web || 'No disponible'}`;
            break;
        case 'E':
            if (empresaInfo.catalogo_url) {
                await sock.sendMessage(id, {
                    document: { url: empresaInfo.catalogo_url },
                    fileName: empresaInfo.catalogo_nombre || "Catálogo.pdf",
                    caption: "📄 Aquí tienes nuestro servicio completo en PDF.\n¡Explora nuestros servicios y no te quedes atras!"
                });
                return;
            } else {
                texto = "❌ El catálogo no está disponible en este momento.";
            }
            break;
        default:
            texto = "Opción en mantenimiento.";
    }
    await sock.sendMessage(id, { text: texto });
}

// --- ENVIAR MENÚ ---
async function enviarMenu(sock, id, menuKey, nombre = '') {
    let texto = '';

    if (menuKey === 'main') {
        const nombreEmpresa = empresaInfo.nombre || 'Nuestra Tienda';
        texto = `¡Hola ${nombre ? ' ' + nombre : ''}! 👋\nBienvenido a nuestro demo de *${nombreEmpresa}* LATAM. (aquí puedes realizar pruebas y funcionamiento)\n\n¿Qué necesitas hoy?\n\n`;
        texto += Object.entries(menuData.main.options)
            .map(([key, opt]) => `*${key}* ${opt.text}`)
            .join('\n');
        texto += '\n\n_Escribe solo la letra_';
    } else if (menuKey === 'buscar_producto') {
        texto = menuData.buscar_producto.mensaje;
    }

    await sock.sendMessage(id, { text: texto });
}

// --- MENÚS ---
const menuData = {
    main: {
        options: {
            'A': { text: '🔥 Descubre ofertas con IA', submenu: 'buscar_producto' },
            'B': { text: '📍 ¿Dónde estamos?', action: 'ubicacion' },
            'C': { text: '🕒 Horarios de atención', action: 'horarios' },
            'D': { text: '📞 Contactanos', action: 'contacto' },
            'E': { text: '📄 Información de Servicio', action: 'catalogo' }
        }
    },
    buscar_producto: {
        mensaje: `🔍 *¿Qué producto estás buscando?*\n\nPuedes escribir:\n• Celular Samsung\n• Laptop gamer hasta 800$\n• TV 55 pulgadas\n\n🛒 *Comandos especiales:*\n• \`agregar 3\` → añade el producto #3\n• \`agregar 2, cantidad 5\` → cantidad personalizada\n• \`finalizar\` → completar pedido\n• \`menu\` → volver al inicio`
    }
};

// --- BÚSQUEDA CON OPENAI + CARRITO ---
async function conectarConOpenAI(mensajeOriginal, id) {
    const ctx = userContext.get(id);
    const TOKEN = process.env.OPENAI_API_KEY;

    try {
        // Inicializar historial
        if (!ctx.list_mensajes || ctx.list_mensajes.length === 0) {
            ctx.list_mensajes = [{
                role: "system",
                content: `Eres un experto en ventas de tecnología. Tu única función es entender búsquedas de productos y devolver un JSON con los filtros. NO respondas nada más.

                Formato obligatorio:
                {
                    "nombre_producto": "nombre o marca/modelo específico o null",
                    "categoria": "celular|laptop|audífonos|televisor|tablet|smartwatch|parlante|null",
                    "precio_maximo": número o null,
                    "marca": "solo si dice explícitamente 'marca Samsung' o similar, sino null",
                    "modelo": "solo si dice 'modelo X' o similar, sino null",
                    "respuesta_breve": "máximo 12 palabras confirmando la búsqueda"
                }

                Ejemplos válidos:
                - "celular hasta 500$" → {"categoria":"celular","precio_maximo":500,"respuesta_breve":"Buscando celulares hasta $500"}
                - "laptop dell" → {"nombre_producto":"dell","categoria":"laptop","respuesta_breve":"Mostrando laptops Dell"}
                - "audífonos" → {"categoria":"audífonos","respuesta_breve":"Aquí tienes audífonos disponibles"}

                Si no es una búsqueda de producto → devuelve todo null y respuesta_breve = "No entendí qué buscas."`
            }];
        }

        const msg = mensajeOriginal.trim();

        // COMANDOS DEL CARRITO
        if (msg.includes('agregar')) {
            return await manejarAgregarCarrito(msg, id);
        }

        if (msg.includes('finalizar') || msg.includes('terminar')) {
            return await manejarFinalizarPedido(id);
        }

        // Búsqueda normal
        ctx.list_mensajes.push({ role: "user", content: msg });

        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-3.5-turbo-1106",
            messages: ctx.list_mensajes,
            response_format: { type: "json_object" },
            temperature: 0.2,
            max_tokens: 300
        }, {
            headers: { Authorization: `Bearer ${TOKEN}` }
        });

        const ia = JSON.parse(response.data.choices[0].message.content);
        ctx.list_mensajes.push({ role: "assistant", content: JSON.stringify(ia) });

        console.log("mensaje ia", ia);
        

        // Limpiar historial
        if (ctx.list_mensajes.length > 20) {
            ctx.list_mensajes = [ctx.list_mensajes[0], ...ctx.list_mensajes.slice(-12)];
        }

        if (!ia.categoria && !ia.nombre_producto && !ia.precio_maximo) {
            return "❌ No entendí qué producto buscas.\nPrueba con: *celular*, *laptop hasta 600*, *audífonos*";
        }

        const filtros = {
            categoria: ia.categoria || null,
            nombre: ia.nombre_producto || null,
            precio_maximo: ia.precio_maximo || null,
            marca: ia.marca || null,
            modelo: ia.modelo || null,
            conStock: true,
            limite: 10
        };

        const productos = await getProductos(filtros);
        ctx.productosRecientes = productos;

        if (productos.length === 0) {
            return `${ia.respuesta_breve || 'Busqué pero no encontré nada'}\n\nPrueba con otros términos.`;
        }

        const lista = productos.map((p, i) => {
            let extra = p.Marca ? ` | ${p.Marca}` : '';
            extra += p.Modelo ? ` ${p.Modelo}` : '';
            extra += p.Caracteristica ?  ` | ${p.Caracteristica}` : '';
            return `${i + 1}. *${p.Nombre_Producto}*\n   $${p.Precio} | Stock: ${p.Stock}${extra}`;
        }).join('\n\n');

        return `${ia.respuesta_breve || 'Aquí tienes lo que encontré:'}\n\n${lista}\n\n🛒 Escribe \`agregar 1\` o \`agregar 1, cantidad 1 o 2 o 3...\` para añadir al carrito`;

    } catch (err) {
        console.error('Error OpenAI:', err.response?.data || err.message);
        return "❌ Error temporal. Inténtalo de nuevo en unos segundos.";
    }
}

// --- AGREGAR AL CARRITO ---
async function manejarAgregarCarrito(mensaje, id) {
    const ctx = userContext.get(id);
    if (!ctx.productosRecientes || ctx.productosRecientes.length === 0) {
        return "⚠️ Primero busca un producto para poder agregarlo.";
    }

    const numeros = mensaje.match(/\d+/g);
    if (!numeros) return "❌ Dime el número del producto. Ej: *agregar 2*";

    const index = parseInt(numeros[0]) - 1;
    if (index < 0 || index >= ctx.productosRecientes.length) {
        return `❌ Elige un número entre 1 y ${ctx.productosRecientes.length}`;
    }

    let cantidad = 1;
    if (numeros.length > 1) cantidad = parseInt(numeros[1]);
    const cantidadMatch = mensaje.match(/cantidad\s+(\d+)/i);
    if (cantidadMatch) cantidad = parseInt(cantidadMatch[1]);

    const producto = ctx.productosRecientes[index];
    if (cantidad > parseInt(producto.Stock)) {
        return `⚠️ Solo hay ${producto.Stock} unidades disponibles de *${producto.Nombre_Producto}*`;
    }

    const item = {
        ID_Producto: producto.ID_Producto,
        Nombre: producto.Nombre_Producto,
        PrecioUnitario: parseFloat(producto.Precio),
        Cantidad: cantidad,
        Stock: producto.Stock
    };

    const existente = ctx.carrito.find(i => i.ID_Producto === item.ID_Producto);
    if (existente) existente.Cantidad += cantidad;
    else ctx.carrito.push(item);

    const total = ctx.carrito.reduce((t, i) => t + (i.Cantidad * i.PrecioUnitario), 0).toFixed(2);

    return `✅ Agregado: ${cantidad} × ${producto.Nombre_Producto}\n\n🛒 Carrito (${ctx.carrito.length} items)\nTotal: *$${total}*\n\nEscribe *finalizar* cuando termines`;
}

// --- FINALIZAR PEDIDO ---
async function manejarFinalizarPedido(id) {
    const ctx = userContext.get(id);
    if (!ctx.carrito || ctx.carrito.length === 0) {
        return "🛒 Tu carrito está vacío.";
    }

    const total = ctx.carrito.reduce((t, i) => t + (i.Cantidad * i.PrecioUnitario), 0);

    const pedido = {
        ID_Pedido: Date.now().toString(),
        Timestamp: new Date().toISOString(),
        ID_Cliente: id,
        carrito: ctx.carrito,
        Total: total,
        Estado: "Pendiente"
    };

    const exito = await registrarPedido(pedido);
    if (exito) {
        for (const item of ctx.carrito) {
            const nuevoStock = parseInt(item.Stock) - item.Cantidad;
            await actualizarStock(item.ID_Producto, nuevoStock);
        }

        ctx.carrito = [];
        ctx.menuActual = 'main';

        return `✅ ¡Pedido recibido!\nID: ${pedido.ID_Pedido}\nTotal: $${total.toFixed(2)}\n\nEn breve te contactamos.\n¡Gracias por tu compra!`;
    } else {
        return "❌ Error al registrar el pedido. Intenta de nuevo.";
    }
}

// --- INICIO ---
async function initializeApp() {
    console.log('Cargando información de la empresa desde Google Sheets...');
    empresaInfo = await getEmpresaInfo();
    console.log('Datos cargados. Iniciando WhatsApp...');
    connectToWhatsApp();
}

initializeApp();