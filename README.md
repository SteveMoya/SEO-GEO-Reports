# SEO / GEO Scanner 🔍

Auditoría técnica SEO + optimización para buscadores de IA (GEO). Analizá URLs en batch, detectá problemas on-page, verificá recursos del sitio y exportá reportes profesionales en PDF, CSV o JSON.

---

## ✨ Features

- **11 checks por URL**: title, meta description, H1, jerarquía de headings, canonical, alt text, schema markup, sitemap, robots.txt y llms.txt
- **Batch scanning**: subí un CSV o pegá URLs directamente
- **Tiempo real**: seguí el progreso via Server-Sent Events con una terminal interactiva
- **Exportación múltiple**: descargá resultados en JSON, CSV o PDF con reporte estilizado
- **GEO-ready**: verifica `llms.txt`, el estándar emergente para optimización en buscadores de IA
- **Fallback automático**: si HTTPS falla, reintenta con HTTP
- **Sin persistencia**: todo en memoria — ideal para escaneos under-demanda

---

## 🚀 Quick Start

```bash
# Clonar
git clone https://github.com/SteveMoya/SEO-GEO-Reports.git
cd SEO-GEO-Reports

# Instalar dependencias
npm install

# Iniciar (modo dev con hot-reload)
npm run dev

# Abrir en el navegador
open http://localhost:3000
```

### Requisitos

- **Node.js** 18+
- **Puppeteer** necesita Chromium. Si no lo tenés, se instala automáticamente con `npm install`

### Scripts

| Comando | Descripción |
|---------|-------------|
| `npm start` | Iniciar servidor |
| `npm run dev` | Iniciar con `--watch` (hot-reload) |

---

## 📋 Cómo usar

### 1. Cargar URLs

Dos formas:

- **Subir archivo**: CSV o TXT con una URL por línea (sin headers)
- **Pegar URLs**: textarea en el frontend, una por línea

Las URLs pueden ir con o sin protocolo — el scanner agrega `https://` automáticamente.

### 2. Ver el escaneo

El frontend muestra:

- Progreso en tiempo real con timer
- Terminal estilo VS Code con cada check y su resultado
- Resumen al finalizar con scores y breakdown por check

### 3. Exportar resultados

```
GET /api/results/:scanId?format=json
GET /api/results/:scanId?format=csv
GET /api/results/:scanId?format=pdf
```

---

## 📡 API

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/api/scan` | Subir archivo CSV/TXT (multipart, max 5MB) |
| `POST` | `/api/scan-url` | Enviar URLs en el body JSON |
| `GET` | `/api/events/:scanId` | Stream SSE con progreso en tiempo real |
| `GET` | `/api/results/:scanId` | Descargar resultados (`?format=json\|csv\|pdf`) |

### Ejemplo con curl

```bash
# Subir archivo
curl -X POST -F "file=@urls.csv" http://localhost:3000/api/scan

# Pegar URLs
curl -X POST http://localhost:3000/api/scan-url \
  -H "Content-Type: application/json" \
  -d '{"urls": "example.com\ngoogle.com"}'
```

---

## ✅ Checks

| Check | Qué verifica |
|-------|-------------|
| **Title Tag** | Longitud y existencia (recomendado: 10-60 caracteres) |
| **Meta Description** | Longitud y existencia (recomendado: 50-160 caracteres) |
| **H1 Tag** | Que exista y sea único |
| **Heading Hierarchy** | Saltos de jerarquía (ej: H1 → H3) |
| **Empty Headings** | Headings sin contenido |
| **Canonical Tag** | Que esté presente |
| **Image Alt Attrs** | Que todas las imágenes tengan atributo alt |
| **Schema Markup** | JSON-LD, Microdata, OpenGraph, Twitter Cards |
| **Sitemap** | Existencia en `/sitemap.xml` y variantes |
| **Robots.txt** | Existencia, User-agent y directivas |
| **LLMs.txt** | Archivo GEO para optimización en buscadores de IA |

### Sistema de puntuación

Cada URL recibe un score de 0 a 100:

- **Pass** → 2 puntos
- **Warning / Info** → 1 punto
- **Fail** → 0 puntos

Visualizado con chips de color: 🟢 ≥80, 🟡 ≥55, 🔴 <55.

---

## 🖨️ Reporte PDF

Generado con Puppeteer en formato **Letter** (8.5" × 11"), incluye:

- Título con fecha, cantidad de URLs y tiempo total
- Summary cards (URLs, checks pasados, advertencias, fallidos)
- Tabla resumen por check
- Cards individuales por URL con score y detalle de cada check
- Header/footer con número de página
- Diseño semáforo (verde/amarillo/rojo)

---

## 🤖 ¿Qué es GEO?

**GEO** (Generative Engine Optimization) es la práctica de optimizar contenido para que sea encontrado y citado por buscadores de IA como ChatGPT, Perplexity, Gemini y Copilot.

El scanner verifica `llms.txt` — un archivo estándar propuesto (similar a `robots.txt`) que permite a los sitios indicarle a los modelos de IA qué contenido pueden usar y cómo referenciarlo.

---

## 🛠️ Stack

| Capa | Tecnología |
|------|-----------|
| Backend | Node.js + Express |
| HTTP | Axios (con soporte HTTPS relajado) |
| HTML parser | Cheerio |
| PDF generation | Puppeteer |
| File upload | Multer |
| Frontend | Vanilla JS, CSS Grid/Flexbox, EventSource |
| Package managers | npm / pnpm / Bun |

---

## 📁 Estructura

```
├── server.js           # Backend principal (Express + lógica de escaneo)
├── package.json        # Dependencias y scripts
├── public/
│   └── index.html      # Frontend SPA
├── urls.example.csv    # Archivo de ejemplo
├── .gitignore
└── README.md
```

---

## 📄 Licencia

MIT — hacé lo que quieras.
