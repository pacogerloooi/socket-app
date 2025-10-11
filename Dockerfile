# Usa Node.js 24 con Alpine para ligereza
FROM node:24-alpine

# Crea el directorio de trabajo
WORKDIR /app

# Copia los archivos de dependencias
COPY package*.json ./

# Instala dependencias
RUN npm install

# Copia el resto del código
COPY . .

# Expón el puerto que usará Socket.IO
EXPOSE 4000

# Comando para iniciar el servidor
CMD ["npm", "start"]
