/**
 * Genera un ID corto único con un prefijo
 * @param {string} prefix - Prefijo para el ID (ej: 'chat', 'msg', 'user')
 * @returns {string} ID único generado
 */
export function generateShortId(prefix = "id") {
  const timestamp = Date.now().toString(36)
  const randomPart = Math.random().toString(36).substring(2, 9)
  return `${prefix}_${timestamp}${randomPart}`
}

/**
 * Genera un ID numérico único
 * @returns {string} ID numérico único
 */
export function generateNumericId() {
  return (
    Date.now().toString() +
    Math.floor(Math.random() * 1000)
      .toString()
      .padStart(3, "0")
  )
}
