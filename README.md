# Cupos Lunas Oscurecidas - Verificador Automático

Script en Node.js que automatiza la verificación de cupos disponibles para reservar citas de peritaje en el sistema de lunas oscurecidas de la PNP.

## Requisitos

- [Node.js](https://nodejs.org/) LTS
- [Chrome](https://www.google.com/chrome/) instalado

## Instalación

```bash
npm install
```

## Configuración

Edita `check-cupos.js` y reemplaza los valores dummy:

```js
const DNI = '77777777';
const CLAVE = 'tu_clave';
const EXPEDIENTE = '11111';
```

## Uso

```bash
# Verificar una sola vez
node check-cupos.js --interval=0

# Verificar cada 5 minutos (por defecto)
node check-cupos.js

# Verificar cada N minutos
node check-cupos.js --interval=10
```

### Probar la alerta

```bash
node alert.js
```

## Estructura

```
├── check-cupos.js   # Script principal
├── alert.js         # Alarma sonora (Mac/Windows)
├── opencode.json    # Config MCP para opencode
├── package.json
└── .gitignore
```

## Funcionamiento

1. Abre Chrome y navega al formulario de login
2. Inicia sesión con DNI y clave
3. Busca el expediente y abre su detalle
4. Ingresa a "Reservar Cita"
5. Selecciona la sede configurada
6. Lee los cupos disponibles
7. Si hay cupos → alerta sonora. Si no → lo registra y espera.

## Alerta

Cuando se detectan cupos disponibles:
- **macOS**: Sonido + voz "Cupos disponibles, ingresa al sistema de lunas polarizadas y agenda tu cita" (se repite 6 veces)
- **Windows**: Beep del sistema + voz con PowerShell SpeechSynthesizer
