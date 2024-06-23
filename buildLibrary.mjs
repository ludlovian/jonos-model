main()

async function main() {
  const model = await importModel()
  console.log('Scanning...')
  await model.library.scan()
  console.log('Writing to file...')
  await model.library.writeToStore()
  console.log('All done!')
}

async function importModel () {
  try {
    return (await import('@ludlovian/jonos-model')).default
  } catch (err) {
    console.log('In Jonos-Model. Importing locally')
    return (await import('./src/index.mjs')).default
  }
}
