# ⛰️ GPX Planner

Fork experimental del analizador original orientado a una planificación visual de rutas: mapa protagonista, búsqueda de lugares, puntos ordenables y edición directa del recorrido.

Analizador de rutas GPX con mapas interactivos y perfiles altimétricos coloreados por pendiente.

## Funcionalidades

- 📂 **Carga de archivos GPX** desde el dispositivo
- 🗺️ **Mapa interactivo** (OpenStreetMap + Leaflet)
- 📊 **Perfil altimétrico** coloreado por pendiente (ECharts)
- ⛰️ **Detección automática de subidas y puertos** con categoría, desnivel y pendientes
- 📍 **Ubicación GPS sobre la ruta** con distancia al track y kilómetro más cercano
- 🛣️ **Porcentaje estimado de asfalto, pista y sendero** a partir de OpenStreetMap
- 🎨 **Comparación multitrack** con varias rutas y colores en un mismo mapa
- ✏️ **Creador y editor de rutas** con inversión, eliminación de puntos y variantes
- 🖼️ **Miniaturas con silueta y perfil** de los tracks guardados
- 💾 **Guardado local y en la nube** (IndexedDB + Supabase)
- 🔄 **Sincronización entre móvil y ordenador** mediante acceso seguro por correo
- 📱 **PWA instalable** en Android, iOS y escritorio
- 📶 **Funciona offline** (Service Worker)

El analizador abre el mapa a toda altura. El tirador inferior permite mostrar u ocultar estadísticas, perfil, superficies y subidas; también funciona con teclado y arrastrando.

Las fuentes se consultan en OpenStreetMap en un corredor de 400 m a lo largo de toda la ruta. Se muestran puntos de agua potable y fuentes etiquetadas como potables; la información depende del registro de OSM y no garantiza su estado actual.


## Escala de pendientes

| Color | Rango | Tipo |
|-------|-------|------|
| 🟩 Verde | 0% - 3% | Llano |
| 🟨 Amarillo | 3% - 6% | Subida suave |
| 🟧 Naranja | 6% - 10% | Subida exigente |
| 🔴 Rojo | 10% - 15% | Puerto duro |
| 🟤 Granate | 15% - 20% | Muro |
| ⬛ Negro | > 20% | Pared |
| 🔵 Azul | < 0% | Descenso |

## Tecnologías

- [Leaflet](https://leafletjs.com/) - Mapas
- [ECharts](https://echarts.apache.org/) - Gráficos
- [TailwindCSS](https://tailwindcss.com/) - Estilos
- IndexedDB - Caché local y funcionamiento sin conexión
- Supabase - Autenticación y almacenamiento sincronizado con RLS

## Despliegue

Hospedado en GitHub Pages: [https://eduardocvk.github.io/gpx_planner/](https://eduardocvk.github.io/gpx_planner/)

La base de datos se versiona mediante las migraciones incluidas en `supabase/migrations`.

## Integraciones de rutas

### Posible integración futura con Garmin

Una sincronización automática completa requeriría el [Garmin Connect Developer Program](https://developer.garmin.com/gc-developer-program/overview/):

- **Courses API** para publicar recorridos en Garmin Connect y sincronizarlos con dispositivos compatibles.
- **Activity API** para recibir actividades realizadas, disponibles también como FIT, GPX o TCX.
- Aprobación de Garmin para uso empresarial, OAuth 2.0 y un backend seguro. En este proyecto el backend podría implementarse con Supabase Edge Functions; los secretos no deben incluirse en el frontend estático.

Garmin no ofrece una API pública de consumo que permita leer y escribir los recorridos privados de una cuenta personal sin esa aprobación. Como alternativa futura, la API oficial de Strava sí permite listar rutas propias y exportarlas como GPX mediante OAuth.

## Comprobación local

Aplicación estática, sin compilación ni dependencias npm. Servir la raíz con un servidor HTTP local. Las pruebas de regresión se ejecutan con `node --test tests/fountains.test.cjs`.
