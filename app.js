const ENDPOINT = 'https://jsonplaceholder.typicode.com/posts';
const SYNC_TAG = 'sync-reportes';

const form = document.getElementById('form-incidencia');
const inputTitulo = document.getElementById('titulo');
const inputDescripcion = document.getElementById('descripcion');
const listaOutbox = document.getElementById('lista-outbox');
const badgeRed = document.getElementById('badge-red');
const btnPurgar = document.getElementById('btn-purgar');
const estadoEnvio = document.getElementById('estado-envio');

let swRegistration = null;

function actualizarIndicadorRed() {
  if (navigator.onLine) {
    badgeRed.textContent = 'En Línea';
    badgeRed.className = 'badge online';
  } else {
    badgeRed.textContent = 'Sin Conexión';
    badgeRed.className = 'badge offline';
  }
}

function mostrarEstado(texto, tipo) {
  estadoEnvio.textContent = texto;
  estadoEnvio.className = 'estado-envio ' + (tipo || '');
}

function registrarServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.warn('[UI] Este navegador no soporta Service Workers.');
    return;
  }

  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.tipo === 'OUTBOX_SINCRONIZADO') {
      console.log('[UI] Confirmación recibida del Service Worker. Actualizando bandeja...');
      mostrarEstado('Los reportes pendientes se enviaron en segundo plano.', 'ok');
      renderizarColaOutbox();
    }
  });

  navigator.serviceWorker.register('./sw.js')
    .then((registro) => {
      swRegistration = registro;
      console.log('[UI] Service Worker registrado. Scope:', registro.scope);
    })
    .catch((error) => {
      console.error('[UI] Error al registrar el Service Worker:', error);
    });
}

function registrarBackgroundSync() {
  if ('serviceWorker' in navigator && 'SyncManager' in window) {
    return navigator.serviceWorker.ready
      .then((registro) => {
        console.log('[Outbox] Registrando Background Sync con la etiqueta:', SYNC_TAG);
        return registro.sync.register(SYNC_TAG);
      })
      .catch((error) => {
        console.warn('[Outbox] No se pudo registrar Background Sync:', error);
      });
  }

  console.log('[Outbox] Este navegador no soporta SyncManager. Se usará el evento online.');
  return Promise.resolve();
}

function procesarEnvioReporte(datosFormulario) {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: datosFormulario.titulo,
      body: datosFormulario.descripcion
    })
  })
    .then((respuesta) => {
      if (!respuesta.ok) {
        throw new Error('Error HTTP del servidor: ' + respuesta.status);
      }
      return respuesta.json();
    })
    .then(() => {
      return guardarRegistro({
        titulo: datosFormulario.titulo,
        descripcion: datosFormulario.descripcion,
        estado: 'sincronizado',
        fechaCreacion: Date.now(),
        fechaSincronizacion: Date.now()
      });
    })
    .catch(() => {
      console.warn('[Outbox] Sin conexión. Encolando transacción localmente...');

      return guardarRegistro({
        titulo: datosFormulario.titulo,
        descripcion: datosFormulario.descripcion,
        estado: 'pendiente',
        fechaCreacion: Date.now()
      })
        .then(() => registrarBackgroundSync());
    })
    .then(() => renderizarColaOutbox());
}

function crearItemOutbox(item) {
  const li = document.createElement('li');
  li.className = 'item ' + item.estado;

  const cabecera = document.createElement('div');
  cabecera.className = 'item-cabecera';

  const titulo = document.createElement('strong');
  titulo.textContent = item.titulo;

  const estado = document.createElement('span');
  estado.className = 'estado ' + item.estado;
  estado.textContent = item.estado;

  cabecera.appendChild(titulo);
  cabecera.appendChild(estado);

  const descripcion = document.createElement('p');
  descripcion.textContent = item.descripcion;

  const fecha = document.createElement('small');
  fecha.textContent = 'Registrado: ' + new Date(item.fechaCreacion).toLocaleString('es-MX');

  li.appendChild(cabecera);
  li.appendChild(descripcion);
  li.appendChild(fecha);

  if (item.fechaSincronizacion) {
    const fechaSync = document.createElement('small');
    fechaSync.textContent = ' | Enviado: ' + new Date(item.fechaSincronizacion).toLocaleString('es-MX');
    li.appendChild(fechaSync);
  }

  return li;
}

function renderizarColaOutbox() {
  return obtenerTodosLosRegistros()
    .then((registros) => {
      listaOutbox.innerHTML = '';

      if (!registros.length) {
        const vacio = document.createElement('li');
        vacio.className = 'item vacio';
        vacio.textContent = 'Aún no hay reportes registrados.';
        listaOutbox.appendChild(vacio);
        return;
      }

      registros
        .slice()
        .sort((a, b) => (b.fechaCreacion || 0) - (a.fechaCreacion || 0))
        .forEach((item) => {
          listaOutbox.appendChild(crearItemOutbox(item));
        });
    })
    .catch((error) => {
      console.error('[Outbox] Error al leer IndexedDB:', error);
    });
}

function sincronizarPendientesFallback() {
  console.log('[Outbox] Conexión detectada. Buscando registros pendientes...');

  return obtenerTodosLosRegistros()
    .then((registros) => {
      const pendientes = registros.filter((item) => item.estado === 'pendiente');

      if (pendientes.length === 0) {
        console.log('[Outbox] No hay transacciones pendientes por sincronizar.');
        return Promise.resolve();
      }

      const promesasDeEnvio = pendientes.map((item) => {
        return fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: item.titulo, body: item.descripcion })
        })
          .then((respuesta) => {
            if (!respuesta.ok) {
              throw new Error('Falla al reintentar el envío del ID ' + item.id);
            }
            return actualizarEstadoRegistro(item.id, 'sincronizado');
          });
      });

      return Promise.all(promesasDeEnvio);
    })
    .then(() => renderizarColaOutbox())
    .catch((error) => {
      console.error('[Outbox] Error durante la sincronización de respaldo:', error);
    });
}

function manejarSubmit(evento) {
  evento.preventDefault();

  const titulo = inputTitulo.value.trim();
  const descripcion = inputDescripcion.value.trim();

  if (!titulo || !descripcion) {
    mostrarEstado('Indica el equipo y lo que observaste.', 'error');
    return;
  }

  const boton = form.querySelector('button[type="submit"]');
  boton.disabled = true;
  mostrarEstado('Guardando reporte...', 'info');

  procesarEnvioReporte({ titulo: titulo, descripcion: descripcion })
    .then(() => {
      form.reset();
      mostrarEstado('Reporte guardado. Revisa la cola.', 'ok');
    })
    .catch((error) => {
      console.error('[Outbox] Error al procesar el reporte:', error);
      mostrarEstado('No se pudo guardar el reporte.', 'error');
    })
    .then(() => {
      boton.disabled = false;
    });
}

function purgarSincronizados() {
  return obtenerTodosLosRegistros()
    .then((registros) => {
      const sincronizados = registros.filter((item) => item.estado === 'sincronizado');

      if (sincronizados.length === 0) {
        mostrarEstado('No hay reportes enviados que limpiar.', 'info');
        return;
      }

      const eliminaciones = sincronizados.map((item) => eliminarRegistro(item.id));

      return Promise.all(eliminaciones)
        .then(() => {
          mostrarEstado('Se limpiaron ' + sincronizados.length + ' reporte(s).', 'ok');
        });
    })
    .then(() => renderizarColaOutbox())
    .catch((error) => {
      console.error('[Outbox] Error al purgar registros:', error);
    });
}

function manejarOnline() {
  actualizarIndicadorRed();

  if (!('SyncManager' in window)) {
    console.log('[Outbox] Navegador sin SyncManager. Ejecutando fallback por evento online...');
    sincronizarPendientesFallback();
  } else {
    console.log('[Outbox] SyncManager disponible. El Service Worker se encargará de la cola.');
  }
}

form.addEventListener('submit', manejarSubmit);
btnPurgar.addEventListener('click', purgarSincronizados);
window.addEventListener('online', manejarOnline);
window.addEventListener('offline', actualizarIndicadorRed);

actualizarIndicadorRed();
registrarServiceWorker();
renderizarColaOutbox();

