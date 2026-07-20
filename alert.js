const { exec } = require('child_process');
const os = require('os');

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const isMac = os.platform() === 'darwin';
const isWin = os.platform() === 'win32';

async function playAlert() {
  const msg = 'Cupos disponibles, ingresa al sistema de lunas polarizadas y agenda tu cita';

  if (isMac) {
    exec('afplay /System/Library/Sounds/Glass.aiff', (err) => {
      if (err) console.error('Error playing sound:', err.message);
    });
    await delay(1000);
    for (let i = 0; i < 6; i++) {
      exec(`say '${msg}'`, (err) => {
        if (err) console.error('Error playing sound:', err.message);
      });
      await delay(10000);
    }
  } else if (isWin) {
    const ps = `Add-Type -AssemblyName System.Speech; ` +
      `[System.Media.SystemSounds]::Asterisk.Play(); ` +
      `$speak = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
      `$speak.Speak('${msg}'); ` +
      `Start-Sleep 1; $speak.Speak('${msg}'); ` +
      `Start-Sleep 1; $speak.Speak('${msg}'); ` +
      `Start-Sleep 1; $speak.Speak('${msg}'); ` +
      `Start-Sleep 1; $speak.Speak('${msg}'); ` +
      `Start-Sleep 1; $speak.Speak('${msg}')`;
    exec(`powershell -Command "${ps}"`, (err) => {
      if (err) console.error('Error playing alert:', err.message);
    });
  } else {
    console.log('ALERTA: Cupos disponibles!');
  }
}

module.exports = { playAlert };

if (require.main === module) {
  console.log('Probando alerta...');
  playAlert();
}
