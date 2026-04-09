#!/usr/bin/env bash
# 🔧 SCRIPT DE CONFIGURACIÓN - MicroSHA CORS Fix
# Uso: bash fix-cors.sh

echo "╔════════════════════════════════════════╗"
echo "║   🚀 SOLUCIÓN CORS - MicroSHA         ║"
echo "║   Backend en Render Caído por CORS    ║"
echo "╚════════════════════════════════════════╝"
echo ""

# Colores
GREEN='✅'
RED='❌'
YELLOW='⚠️'
BLUE='📝'

echo "$BLUE PASO 1: Verificar que estamos en el directorio correcto"
if [ -f "src/server.js" ]; then
    echo "$GREEN Directorio correcto: $(pwd)"
else
    echo "$RED No se encontró src/server.js"
    echo "   Debes estar en la carpeta: microsha-backend-main"
    exit 1
fi

echo ""
echo "$BLUE PASO 2: Verificar cambios realizados"
if grep -q "credentials: true" src/server.js; then
    echo "$GREEN Cambios de CORS ya aplicados ✓"
else
    echo "$RED No se detectan cambios. Algunos archivos no se aplicaron correctamente."
fi

echo ""
echo "$BLUE PASO 3: Git status"
echo "───────────────────────────────────────"
git status

echo ""
echo "$BLUE PASO 4: Comandos a ejecutar"
echo "───────────────────────────────────────"
echo ""
echo "1️⃣ Agregar cambios:"
echo "   $ git add src/server.js .env.example verify-cors.js"
echo ""
echo "2️⃣ Commit:"
echo "   $ git commit -m \"Fix: CORS configuration for Render\""
echo ""
echo "3️⃣ Push:"
echo "   $ git push"
echo ""
echo "4️⃣ En Render Dashboard:"
echo "   • Ve a: render.com → microsha-backend"
echo "   • Click: Environment"
echo "   • Agrega variable:"
echo "     Name: CORS_ORIGIN"
echo "     Value: https://microsha.vercel.app"
echo "   • Click: Save"
echo ""
echo "5️⃣ Redeploy en Render:"
echo "   • Click: Deployments"
echo "   • Click: Deploy latest commit"
echo "   • Espera 2-3 minutos"
echo ""
echo "6️⃣ Verificar:"
echo "   $ node verify-cors.js"
echo ""

echo "╔════════════════════════════════════════╗"
echo "║  📌 CHECKLIST DE EJECUCIÓN           ║"
echo "╚════════════════════════════════════════╝"
echo ""
echo "☐ 1. Git push completado"
echo "☐ 2. CORS_ORIGIN configurada en Render"
echo "☐ 3. Redeploy completado en Render"
echo "☐ 4. Esperar 2-3 minutos"
echo "☐ 5. Ejecutar: node verify-cors.js"
echo "☐ 6. Verificar /ping devuelve 'pong'"
echo "☐ 7. Abrir https://microsha.vercel.app"
echo "☐ 8. Revisar Console en DevTools (F12) sin errores CORS"
echo ""
echo "✨ Una vez completado todo, avisa para verificar el estado!"
