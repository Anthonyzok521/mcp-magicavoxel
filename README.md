# mcp-magicavoxel

Servidor [MCP](https://modelcontextprotocol.io) que permite a un agente de IA (Claude Code, Claude Desktop, Cursor…) **construir modelos voxel y guardarlos como archivos `.vox` de [MagicaVoxel](https://ephtracy.github.io/)**.

Pídele a tu agente *"crea un árbol en voxel y guárdalo como tree.vox"* y lo construirá con primitivas, revisará el resultado con vistas previas en PNG y guardará un archivo listo para abrir en MagicaVoxel.

![Árbol creado con mcp-magicavoxel](docs/tree-preview.png)

*Vista previa del manzano de ejemplo ([`docs/tree.vox`](docs/tree.vox)), creado por Claude Code con este servidor.*

## Características

- Escribe `.vox` en formato **200** (el de MagicaVoxel 0.99.7), con grafo de escena, paleta y materiales.
- Varios objetos por escena, cada uno de hasta 256×256×256.
- Primitivas: cajas, esferas/elipsoides, cilindros/conos, líneas, voxeles sueltos y simetría.
- Generación procedural con expresiones JavaScript por voxel.
- Materiales de MagicaVoxel: metal, vidrio y emisivo.
- Vistas previas PNG (isométrica, frontal, lateral, superior…) para que el agente vea lo que construye.
- Carga `.vox` existentes para editarlos.
- Paleta automática: los colores se indican en hex (`"#ff8800"`).
- Sin dependencias nativas: solo Node.js.

## Requisitos

- Node.js 18 o superior
- MagicaVoxel (para abrir los resultados)

## Instalación

```bash
git clone https://github.com/Anthonyzok521/mcp-magicavoxel.git
cd mcp-magicavoxel
npm install
```

### Claude Code

```bash
claude mcp add voxel -s user -e VOX_OUTPUT_DIR="/ruta/a/MagicaVoxel/vox" -- node /ruta/a/mcp-magicavoxel/src/server.mjs
```

Reinicia Claude Code y comprueba con `claude mcp list` que `voxel` aparece como conectado.

### Otros clientes MCP (Claude Desktop, Cursor…)

```json
{
  "mcpServers": {
    "voxel": {
      "command": "node",
      "args": ["/ruta/a/mcp-magicavoxel/src/server.mjs"],
      "env": { "VOX_OUTPUT_DIR": "/ruta/a/MagicaVoxel/vox" }
    }
  }
}
```

`VOX_OUTPUT_DIR` es la carpeta donde se guardan los nombres de archivo relativos. Si apunta a la carpeta `vox` de MagicaVoxel, los modelos aparecen directamente en su lista de archivos. Si no se define, se usa el directorio de trabajo del servidor.

## Herramientas

| Herramienta | Descripción |
|---|---|
| `new_scene` | Vacía la escena |
| `create_model` | Crea un objeto (tamaño y posición en el mundo) |
| `move_model` / `delete_model` | Mueve o elimina un objeto |
| `fill_box` | Caja maciza o hueca |
| `fill_sphere` | Esfera o elipsoide, maciza o hueca |
| `fill_cylinder` | Cilindro o cono en el eje x, y o z |
| `draw_line` | Línea entre dos puntos, con grosor |
| `set_voxels` | Voxeles individuales |
| `fill_expression` | Pinta con una expresión JavaScript evaluada por voxel |
| `mirror` | Refleja una mitad del objeto sobre la otra |
| `set_material` | Asigna material diffuse, metal, glass o emit a un color |
| `get_scene_info` | Objetos, tamaños, número de voxeles y colores usados |
| `render_preview` | Imágenes PNG de la escena desde una o varias vistas |
| `save_vox` / `load_vox` | Guarda o carga archivos `.vox` |

Cualquier herramienta de pintura acepta el color `"empty"` para borrar voxeles.

### Coordenadas

Igual que MagicaVoxel: **x** hacia la derecha, **y** en profundidad (el frente tiene y baja) y **z hacia arriba**. Las coordenadas de las herramientas de pintura son locales a cada objeto, y `position` coloca el voxel (0,0,0) del objeto en el mundo.

### Ejemplos de peticiones

- *"Crea una casita medieval con techo rojo y una ventana que brille, y guárdala como casa.vox"*
- *"Genera un terreno con colinas de 64×64 usando ruido y ponle agua en las zonas bajas"*
- *"Abre castle.vox, añade una bandera en la torre más alta y guárdalo como castle2.vox"*

## Limitaciones

- La vista previa usa sombreado plano: sirve para comprobar forma y color, no es el path tracer de MagicaVoxel.
- Al cargar un `.vox` se conservan las posiciones de los objetos, pero no las rotaciones, los fotogramas de animación ni la configuración de render (cámaras, luces).
- Los materiales pertenecen a los colores de la paleta: todos los voxeles de un mismo color comparten material.
- La paleta admite 255 colores. Cuando se llena, los colores nuevos se aproximan al más parecido.
- `fill_expression` ejecuta el código en un contexto `vm` de Node con un límite de 20 segundos. **No es un sandbox de seguridad**: úsalo solo con agentes y código en los que confíes.

## Desarrollo

```bash
npm test                                 # prueba de extremo a extremo por stdio
node test-e2e.mjs <salida> <carpeta_vox> # además carga y dibuja los ejemplos de MagicaVoxel
```

- `src/vox.mjs`: modelo en memoria y lectura/escritura del formato `.vox`.
- `src/render.mjs`: trazador de rayos ortográfico y codificador PNG.
- `src/server.mjs`: servidor MCP y sus herramientas.

Referencia del formato: [voxel-model](https://github.com/ephtracy/voxel-model) de ephtracy.

MagicaVoxel es un programa de [ephtracy](https://ephtracy.github.io/). Este proyecto no está afiliado a él.

## Licencia

[MIT](LICENSE) © Anthonyzok521
