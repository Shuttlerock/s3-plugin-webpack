import http from 'http'
import https from 'https'
import s3 from 's3'
import fs from 'fs'
import path from 'path'
import ProgressBar from 'progress'
import cdnizer from 'cdnizer'
import _ from 'lodash'
import aws from 'aws-sdk'

import {
  addSeperatorToPath,
  addTrailingS3Sep,
  getDirectoryFilesRecursive,
  UPLOAD_IGNORES,
  DEFAULT_UPLOAD_OPTIONS,
  DEFAULT_S3_OPTIONS,
  REQUIRED_S3_OPTS,
  REQUIRED_S3_UP_OPTS,
  PATH_SEP,
  DEFAULT_TRANSFORM,
} from './helpers'

http.globalAgent.maxSockets = https.globalAgent.maxSockets = 50

var compileError = function(compilation, error) {
  compilation.errors.push(new Error(error))
}

module.exports = class S3Plugin {
  constructor(options = {}) {
    var {
      include,
      exclude,
      basePath,
      directory,
      htmlFiles,
      basePathTransform = DEFAULT_TRANSFORM,
      s3Options = {},
      cdnizerOptions = {},
      s3UploadOptions = {},
      cloudfrontInvalidateOptions = {}
    } = options

    this.uploadOptions = s3UploadOptions
    this.cloudfrontInvalidateOptions = cloudfrontInvalidateOptions
    this.isConnected = false
    this.cdnizerOptions = cdnizerOptions
    this.urlMappings = []
    this.uploadTotal = 0
    this.uploadProgress = 0
    this.basePathTransform = basePathTransform
    basePath = basePath ? addTrailingS3Sep(basePath) : ''

    this.options = {
      directory,
      include,
      exclude,
      basePath,
      htmlFiles: typeof htmlFiles === 'string' ? [htmlFiles] : htmlFiles
    }

    this.clientConfig = {
      maxAsyncS3: 50,
      s3Options: _.merge({}, DEFAULT_S3_OPTIONS, s3Options)
    }

    this.noCdnizer = !Object.keys(this.cdnizerOptions).length

    if (!this.noCdnizer && !this.cdnizerOptions.files)
      this.cdnizerOptions.files = []
  }

  apply(compiler) {
    this.connect()

    var isDirectoryUpload = !!this.options.directory,
        hasRequiredOptions = this.client.s3.config.credentials !== null,
        hasRequiredUploadOpts = _.every(REQUIRED_S3_UP_OPTS, type => this.uploadOptions[type])

    // Set directory to output dir or custom
    this.options.directory = this.options.directory || compiler.options.output.path || compiler.options.output.context || '.'

    compiler.plugin('after-emit', (compilation, cb) => {
      if (!hasRequiredOptions) {
        compileError(compilation, `S3Plugin: Must provide ${REQUIRED_S3_OPTS.join(', ')}`)
        cb()
      }

      if (!hasRequiredUploadOpts) {
        compileError(compilation, `S3Plugin-RequiredS3UploadOpts: ${REQUIRED_S3_UP_OPTS.join(', ')}`)
        cb()
      }

      if (isDirectoryUpload) {
        let dPath = addSeperatorToPath(this.options.directory)

        this.getAllFilesRecursive(dPath)
          .then((files) => this.handleFiles(files, cb))
          .then(() => cb())
          .catch(e => this.handleErrors(e, compilation, cb))
      } else {
        this.getAssetFiles(compilation)
          .then((files) => this.handleFiles(files))
          .then(() => cb())
          .catch(e => this.handleErrors(e, compilation, cb))
      }
    })
  }

  handleFiles(files) {
    return this.changeUrls(files)
      .then((files) => this.filterAllowedFiles(files))
      .then((files) => this.uploadFiles(files))
      .then(() => this.invalidateCloudfront())
  }

  handleErrors(error, compilation, cb) {
    compileError(compilation, `S3Plugin: ${error}`)
    cb()
  }

  getAllFilesRecursive(fPath) {
    return getDirectoryFilesRecursive(fPath)
  }

  addPathToFiles(files, fPath) {
    return files.map(file => ({name: file, path: path.resolve(fPath, file)}))
  }

  getFileName(file = '') {
    return _.includes(file, PATH_SEP) ? file.substring(_.lastIndexOf(file, PATH_SEP) + 1) : file
  }

  getAssetFiles({assets}) {
    var files = _.map(assets, (value, name) => ({name, path: value.existsAt}))

    return Promise.resolve(files)
  }

  cdnizeHtml(file) {
    return new Promise((resolve, reject) => {
      fs.readFile(file.path, (err, data) => {
        if (err)
          return reject(err)

        fs.writeFile(file.path, this.cdnizer(data.toString()), (err) => {
          if (err)
            return reject(err)

          resolve(file)
        })
      })
    })
  }

  changeUrls(files = []) {
    if (this.noCdnizer)
      return Promise.resolve(files)

    var allHtml,
        {directory, htmlFiles = []} = this.options

    allHtml = htmlFiles.length ? this.addPathToFiles(htmlFiles, directory).concat(files) : files
    this.cdnizerOptions.files = allHtml.map(({name}) => `*${name}*`)
    this.cdnizer = cdnizer(this.cdnizerOptions)

    var [cdnizeFiles, otherFiles] = _(allHtml)
      .uniq('name')
      .partition((file) => /\.(html)/.test(file.name)) // |css - Add when cdnize css is done
      .value()

    return Promise.all(cdnizeFiles.map(file => this.cdnizeHtml(file)).concat(otherFiles))
  }

  // For future implimentation
  // changeCssUrls(files = []) {
  //   if (this.noCdnizer)
  //     return Promise.resolve(files)

  //   data.replace(/url\(\/images/g, `url(${imagePath}`)

  //   return this.cdnizeCss(cssFile2, imagePath, files)
  // }

  filterAllowedFiles(files) {
    return files.reduce((res, file) => {
      if (this.isIncludeAndNotExclude(file.name) && !this.isIgnoredFile(file.name))
        res.push(file)

      return res
    }, [])
  }

  isIgnoredFile(file) {
    return _.some(UPLOAD_IGNORES, ignore => new RegExp(ignore).test(file))
  }

  isIncludeAndNotExclude(file) {
    var isExclude,
        isInclude,
        {include, exclude} = this.options

    isInclude = include ? include.test(file) : true
    isExclude = exclude ? exclude.test(file) : false

    return isInclude && !isExclude
  }

  connect() {
    if (this.isConnected)
      return

    this.client = s3.createClient(this.clientConfig)
    this.isConnected = true
  }

  transformBasePath() {
    return Promise.resolve(this.basePathTransform(this.options.basePath))
      .then(addTrailingS3Sep)
      .then(nPath => this.options.basePath = nPath)
  }

  setupProgressBar(uploadFiles) {
    var progressAmount = Array(uploadFiles.length)
    var progressTotal = Array(uploadFiles.length)
    var countUndefined = (array) => _.reduce(array, (res, value) => res += _.isUndefined(value) ? 1 : 0, 0)
    var calculateProgress = () => _.sum(progressAmount) / _.sum(progressTotal)
    var progressTracker = 0

    var progressBar = new ProgressBar('Uploading [:bar] :percent :etas', {
      complete: '>',
      incomplete: '+',
      total: 100
    })

    uploadFiles.forEach(function({upload}, i) {
      upload.on('progress', function() {
        var definedModifier,
            progressValue

        progressTotal[i] = this.progressTotal
        progressAmount[i] = this.progressAmount
        definedModifier = countUndefined(progressTotal) / 10
        progressValue = calculateProgress() - definedModifier

        if (progressValue !== progressTracker) {
          progressBar.update(progressValue)
          progressTracker = progressValue
        }
      })
    })
  }

  uploadFiles(files = []) {
    return this.transformBasePath()
      .then(() => {
        var uploadFiles = files.map(file => this.uploadFile(file.name, file.path))

        this.setupProgressBar(uploadFiles)

        return Promise.all(uploadFiles.map(({promise}) => promise))
      })
  }

  uploadFile(fileName, file) {
    var upload,
        s3Params = _.merge({Key: this.options.basePath + fileName}, DEFAULT_UPLOAD_OPTIONS, this.uploadOptions)

    // Remove Gzip from encoding if ico
    if (/\.ico/.test(fileName) && s3Params.ContentEncoding === 'gzip')
      delete s3Params.ContentEncoding

    if (/\.css\.gz/.test(fileName)) {
      s3Params.ContentType = 'text/css'
      s3Params.ContentEncoding = 'gzip'
    }

    if (/\.js\.gz/.test(fileName)) {
      s3Params.ContentType = 'application/javascript'
      s3Params.ContentEncoding = 'gzip'
    }

    upload = this.client.uploadFile({
      localFile: file,
      s3Params
    })

    if (!this.noCdnizer)
      this.cdnizerOptions.files.push(`*${fileName}*`)

    var promise = new Promise((resolve, reject) => {
      upload.on('error', reject)
      upload.on('end', () => resolve(file))
    })

    return {upload, promise}
  }

  invalidateCloudfront() {
    var {clientConfig, cloudfrontInvalidateOptions} = this

    return new Promise(function(resolve, reject) {
      if (cloudfrontInvalidateOptions.DistributionId) {
        var cloudfront = new aws.CloudFront()

        cloudfront.config.update({
          accessKeyId: clientConfig.s3Options.accessKeyId,
          secretAccessKey: clientConfig.s3Options.secretAccessKey,
        })

        cloudfront.createInvalidation({
          DistributionId: cloudfrontInvalidateOptions.DistributionId,
          InvalidationBatch: {
            CallerReference: Date.now().toString(),
            Paths: {
              Quantity: cloudfrontInvalidateOptions.Items.length,
              Items: cloudfrontInvalidateOptions.Items
            }
          }
        }, (err, res) => err ? reject(err) : resolve(res.Id))
      } else {
        return resolve(null)
      }
    })
  }
}
