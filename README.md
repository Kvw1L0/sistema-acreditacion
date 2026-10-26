# Sistema de Acreditación Web (Excel + Escáner RUT / QR Cédula Chilena)

Aplicación web para control de acceso y acreditación de invitados en eventos, lista para alojarse gratis en **GitHub Pages** y sincronizar múltiples dispositivos en tiempo real mediante **Supabase** (o funcionar 100% en modo local).

## Estructura de Rutas

- **`/admin` (`admin/index.html`)**: Panel de administración protegido con contraseña/PIN (`1234` por defecto).
  - **Carga masiva de Excel (`.xlsx`, `.xls`, `.csv`)**: Detecta automáticamente las columnas de **RUT** y **Nombre Completo**, limpiando puntos y guiones.
  - **Dashboard en tiempo real**: Total de invitados, acreditados, pendientes y porcentaje de ocupación.
  - **Registro "Walk-in"**: Formulario para inscribir y acreditar a invitados que llegan a última hora.
  - **Tabla interactiva**: Buscador en vivo, filtros por estado y botón para acreditar/desacreditar manualmente.
  - **Exportación de Reporte Excel**: Descarga un archivo `.xlsx` actualizado con quiénes asistieron y la fecha/hora exacta de ingreso.
  - **Configuración de Instancia y Nube**: Permite personalizar el nombre del evento, el PIN de acceso y pegar las credenciales de **Supabase** para sincronizar varios celulares/PCs en vivo.

- **`/escaner.html`**: Vista rápida para operadores y acreditadores en puerta.
  - **Lector QR de Cédula de Identidad Chilena**: Usa la cámara del celular o webcam para leer el código QR del carnet chileno, extrayendo automáticamente el parámetro `RUN=` de la URL del Registro Civil.
  - **Buscador Manual por RUT o Nombre**: Permite buscar escribiendo el RUT (con o sin puntos/guion) o el nombre del invitado.
  - **Bloqueo de Doble Ingreso**:
    - 🟢 **Verde (Acceso Autorizado)**: Si el invitado está en la lista y no había ingresado, lo marca como acreditado y registra la hora exacta.
    - 🔴 **Rojo (YA ACREDITADO)**: Si intentan escanear o acreditar a una persona que ya ingresó antes, bloquea el acceso y muestra la hora exacta de su ingreso previo.
    - 🟡 **Amarillo (No Registrado)**: Alerta cuando el RUT no figura en el padrón.
