#!/usr/bin/env node
/**
 * Verificador de CORS para MicroSHA Backend
 * 
 * Uso: node verify-cors.js
 * O:   npm run verify-cors (si agregas el script en package.json)
 */

const https = require('https');

const BACKEND_URL = 'https://microsha-backend.onrender.com';
const FRONTEND_ORIGIN = 'https://microsha.vercel.app';

console.log('🔍 Verificando configuración CORS...\n');
console.log(`Backend: ${BACKEND_URL}`);
console.log(`Frontend: ${FRONTEND_ORIGIN}\n`);

const endpoints = [
  '/ping',
  '/groups/me',
  '/trips',
  '/admin/history',
  '/admin/system/flags'
];

async function checkCors(endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'microsha-backend.onrender.com',
      path: endpoint,
      method: 'OPTIONS',
      headers: {
        'Origin': FRONTEND_ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Content-Type,Authorization'
      }
    };

    const req = https.request(options, (res) => {
      const corsOrigin = res.headers['access-control-allow-origin'];
      const corsMethods = res.headers['access-control-allow-methods'];
      const corsHeaders = res.headers['access-control-allow-headers'];

      resolve({
        endpoint,
        status: res.statusCode,
        corsOrigin: corsOrigin || '❌ NO PRESENT',
        corsMethods: corsMethods || '❌ NO PRESENT',
        corsHeaders: corsHeaders || '❌ NO PRESENT',
        ok: corsOrigin && (corsOrigin === '*' || corsOrigin === FRONTEND_ORIGIN)
      });
    });

    req.on('error', (error) => {
      reject(`${endpoint}: ${error.message}`);
    });

    req.setTimeout(5000, () => {
      req.destroy();
      reject(`${endpoint}: Timeout`);
    });

    req.end();
  });
}

(async () => {
  let allOk = true;
  
  for (const endpoint of endpoints) {
    try {
      const result = await checkCors(endpoint);
      
      const status = result.ok ? '✅' : '❌';
      console.log(`${status} ${result.endpoint}`);
      console.log(`   Status: ${result.status}`);
      console.log(`   CORS Origin: ${result.corsOrigin}`);
      console.log(`   CORS Methods: ${result.corsMethods}`);
      console.log(`   CORS Headers: ${result.corsHeaders}\n`);
      
      if (!result.ok) allOk = false;
    } catch (error) {
      console.log(`❌ ${error}\n`);
      allOk = false;
    }
  }

  if (allOk) {
    console.log('✅ CORS está correctamente configurado!');
    process.exit(0);
  } else {
    console.log('❌ CORS no está correctamente configurado.');
    console.log('\n📋 Pasos para arreglar:');
    console.log('1. Push los cambios: git push');
    console.log('2. En Render, ve a Environment');
    console.log(`3. Agrega: CORS_ORIGIN=${FRONTEND_ORIGIN}`);
    console.log('4. Redeploy: click en "Deploy latest commit"');
    console.log('5. Espera 2-3 minutos y verifica nuevamente');
    process.exit(1);
  }
})();
