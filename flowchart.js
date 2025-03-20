const fs = require('node:fs/promises');

async function makeFlowchart(flow) {
  let flowchart = "flowchart TD\n";

  for (const step of flow) {
    let label = step.message ? step.message.replace(/\n/g, "<br>") : step.step;

    if (step.input === "menu") {
      label = step.message ? step.message.replace(/\n/g, "<br>") : step.step;
      for (const option of step.options) {
        flowchart += `  ${step.step}("${label}") --> |"${option.text}"| ${step.next[option.value]}\n`;
      }
    } else if (step.optin) {
      label += `<br>[${step.optin.method}]`;
      // Corrected subroutine syntax:
      flowchart += `  ${step.step}["${label}"] --> ${step.next}\n`;
    } else {
      flowchart += `  ${step.step}["${label}"] --> ${step.next}\n`;
    }
  }

  try {
    await fs.writeFile('flowchart.md', '```mermaid\n' + flowchart + '\n```');
    console.log('Flowchart gerado com sucesso!');
  } catch (err) {
    console.error('Erro ao gravar o arquivo de flowchart:', err);
  }
}

module.exports = { makeFlowchart };
