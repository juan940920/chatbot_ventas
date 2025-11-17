# --- ETAPA 1: Construcción ---
# Usamos una imagen oficial de Node.js para instalar las dependencias
FROM node:22-alpine AS builder

# Establecemos el directorio de trabajo dentro del contenedor
WORKDIR /app

# Copiamos los archivos de gestión de paquetes
COPY package*.json ./

# Instalamos las dependencias
RUN npm install

# --- ETAPA 2: Producción ---
# Usamos una imagen más ligera de Node.js para la ejecución
FROM node:22-alpine

# Establecemos el directorio de trabajo
WORKDIR /app

# Copiamos las dependencias desde la etapa de construcción
COPY --from=builder /app/node_modules ./node_modules

# Copiamos el resto del código de la aplicación
COPY . .

# Exponemos el puerto que usa Express para el QR
EXPOSE 3000

# El comando para iniciar la aplicación cuando el contenedor se ejecute
CMD ["node", "index.js"]