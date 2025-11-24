require('dotenv').config(); 
const { google } = require('googleapis');

// Autenticación con Google Sheets
const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const SHEETS = {
    CLIENTES: 'Clientes',
    PRODUCTOS: 'Productos',
    EMPRESA: 'Empresa',
    PEDIDOS: 'Pedidos'
};

async function appendRow(data, sheetName) {
    const request = {
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A:Z`,
        valueInputOption: 'USER_ENTERED',
        resource: {
            values: [data],
        },
    };

    try {
        const response = await sheets.spreadsheets.values.append(request);
        console.log(`Fila agregada en ${sheetName}:`, response.data);
    } catch (error) {
        console.error(`Error al agregar fila en ${sheetName}:`, error);
    }
}

async function findContactByPhone(phone) {
    const request = {
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEETS.CLIENTES}!A:Z`,
    };

    try {
        const response = await sheets.spreadsheets.values.get(request);
        const rows = response.data.values;

        if (!rows || rows.length === 0) {
            console.log("No hay datos en la hoja Clientes.");
            return null;
        }

        const contactRow = rows.find(row => row[2] === phone);

        if (contactRow) {
            return {
                id_cliente: contactRow[0],
                nombre: contactRow[1],
                telefono: contactRow[2],
                estado: contactRow[3],
                fecha_interaccion: contactRow[4]
            };
        } else {
            return null;
        }
    } catch (error) {
        console.error("Error al buscar contacto:", error);
        return null;
    }
}

async function createContactIfNotExists(phone, name) {
    const existingContact = await findContactByPhone(phone);

    if (!existingContact) {
        const newContact = [
            Date.now().toString(),
            name || 'Desconocido',
            phone,
            'Nuevo',
            new Date().toLocaleString()
        ];

        await appendRow(newContact, SHEETS.CLIENTES);
        console.log("Nuevo contacto creado:", phone);
        return newContact;
    } else {
        console.log("El contacto ya existe:", phone);
        return existingContact;
    }
}

async function getProductos(filtros = {}) {
    try {
        const request = {
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEETS.PRODUCTOS}!A:L`,
        };

        const response = await sheets.spreadsheets.values.get(request);
        const rows = response.data.values;

        if (!rows || rows.length === 0) {
            return [];
        }

        const productos = rows.map(row => ({
            ID_Producto: row[0],
            Nombre_Producto: row[1],
            Marca: row[2] || "",
            Modelo: row[3] || "",
            Categoria: row[4] || "",
            Precio: row[5] || "",
            Stock: row[6] || "",
            Unidad_Medida: row[7] || "",
            Peso: row[8] || "",
            Dimension: row[9] || "",
            URL_Imagen: row[10] || "",
            Caracteristica: row[11] || "",
            Estado: row[12] || ""
        }));

        console.log(`getProductos - Total productos en base de datos: ${productos.length}`);

        let productosFiltrados = productos;

        if (filtros.categoria) {
            const categoriaLower = filtros.categoria.toLowerCase();
            productosFiltrados = productosFiltrados.filter(p => 
                p.Categoria?.toLowerCase().includes(categoriaLower)
            );
            console.log(`Filtro por categoría "${filtros.categoria}": ${productosFiltrados.length} productos`);
        }

        if (filtros.nombre) {
            const busqueda = filtros.nombre.toLowerCase();
            productosFiltrados = productosFiltrados.filter(p => {
                const camposDeBusqueda = [
                    p.Nombre_Producto?.toLowerCase() || "",
                    p.Marca?.toLowerCase() || "",
                    p.Modelo?.toLowerCase() || ""
                ];
                
                return camposDeBusqueda.some(campo => campo && campo.includes(busqueda));
            });
            
            console.log(`Filtro por nombre "${filtros.nombre}": ${productosFiltrados.length} productos`);
        }

        if (filtros.marca) {
            const marcaLower = filtros.marca.toLowerCase();
            productosFiltrados = productosFiltrados.filter(p => 
                p.Marca?.toLowerCase().includes(marcaLower)
            );
            console.log(`Filtro por marca "${filtros.marca}": ${productosFiltrados.length} productos`);
        }

        if (filtros.modelo) {
            const modeloLower = filtros.modelo.toLowerCase();
            productosFiltrados = productosFiltrados.filter(p => 
                p.Modelo?.toLowerCase().includes(modeloLower)
            );
            console.log(`Filtro por modelo "${filtros.modelo}": ${productosFiltrados.length} productos`);
        }

        if (filtros.conStock) {
            productosFiltrados = productosFiltrados.filter(p => 
                parseInt(p.Stock) > 0
            );
            console.log(`Filtro por stock (solo con stock): ${productosFiltrados.length} productos`);
        }

        if (filtros.precio_maximo) {
            const precioMaximo = parseFloat(filtros.precio_maximo);
            productosFiltrados = productosFiltrados.filter(p => {
                
                const precioNumerico = parseFloat(p.Precio.replace(/[^0-9.-]+/g, ""));
                
                return !isNaN(precioNumerico) && precioNumerico <= precioMaximo;
            });
            console.log(`Filtro por precio máximo (hasta ${precioMaximo}): ${productosFiltrados.length} productos`);
        }

        if (filtros.limite) {
            const limiteAntes = productosFiltrados.length;
            productosFiltrados = productosFiltrados.slice(0, filtros.limite);
            console.log(`Aplicando límite: ${productosFiltrados.length} de ${limiteAntes} productos`);
        }

        console.log(`getProductos - Resultados finales: ${productosFiltrados.length} productos`);
        console.log("productos filtrados: ", productosFiltrados);
        
        return productosFiltrados;
    } catch (error) {
        console.error("Error en getProductos:", error);
        return [];
    }
}

async function registrarPedido(pedido) {
    try {

        const filas = pedido.carrito.map(item => [
            pedido.ID_Pedido,
            pedido.ID_Cliente,
            item.ID_Producto,
            item.Cantidad.toString(),
            item.PrecioUnitario.toString(),
            (item.Cantidad * item.PrecioUnitario).toString(),
            pedido.Timestamp,
            pedido.Estado
        ]);

        //console.log("El array con map de filas", filas);  

        const request = {
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEETS.PEDIDOS}!A:Z`,
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: filas,
            },
        };

        const response = await sheets.spreadsheets.values.append(request);
        //console.log(`Pedido ${pedido.ID_Pedido} registrado con ${filas.length} productos:`, response.data);
        return true;
    } catch (error) {
        console.error("Error al registrar pedido:", error);
        return false;
    }
}

async function actualizarStock(idProducto, nuevaCantidad) {
    try {
        // Primero obtenemos todos los productos para encontrar la fila del producto
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEETS.PRODUCTOS}!A:Z`,
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            throw new Error("No se encontraron productos");
        }

        // Buscamos la fila del producto (asumiendo que ID_Producto está en la columna A)
        const filaIndex = rows.findIndex(row => row[0] === idProducto);
        if (filaIndex === -1) {
            throw new Error("Producto no encontrado");
        }

        // Actualizamos el stock (asumiendo que Stock está en la columna G, índice 6)
        const rango = `${SHEETS.PRODUCTOS}!G${filaIndex + 1}`; // +1 porque Google Sheets usa 1-based index
        
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: rango,
            valueInputOption: "USER_ENTERED",
            resource: {
                values: [[nuevaCantidad]]
            }
        });

        console.log(`Stock actualizado para producto ${idProducto}: ${nuevaCantidad}`);
        return true;
    } catch (error) {
        console.error("Error al actualizar stock:", error);
        return false;
    }
}

async function getEmpresaInfo() {
    try {
        const request = {
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEETS.EMPRESA}!A:B`, // Leemos las columnas A y B
        };

        const response = await sheets.spreadsheets.values.get(request);
        const rows = response.data.values;

        if (!rows || rows.length < 2) {
            console.log("La hoja 'Empresa' está vacía o no tiene el formato correcto.");
            return {};
        }

        // Convertimos las filas en un objeto clave-valor
        const info = {};
        // Empezamos desde el índice 1 para saltar la fila de encabezados
        for (let i = 1; i < rows.length; i++) {
            const key = rows[i][0];
            const value = rows[i][1];
            if (key && value) {
                // Limpiamos la clave para que sea un nombre de variable válido (ej: "contacto whatsapp" -> "contacto_whatsapp")
                const cleanKey = key.toLowerCase().replace(/\s+/g, '_');
                info[cleanKey] = value;
            }
        }

        console.log("Información de la empresa cargada:", info);
        return info;

    } catch (error) {
        console.error("Error al leer la información de la empresa:", error);
        return {};
    }
}

module.exports = {
    appendRow,
    findContactByPhone,
    createContactIfNotExists,
    getProductos,
    registrarPedido,
    actualizarStock,
    SHEETS,
    getEmpresaInfo
};