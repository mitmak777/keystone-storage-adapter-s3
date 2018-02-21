/*
TODO
- Check whether files exist before uploading (will always overwrite as-is)
- Support multiple retry attempts if a file exists (see FS Adapter)
*/

// Mirroring keystone 0.4's support of node 0.12.
var assign = require('object-assign');
var debug = require('debug')('keystone-s3');
var ensureCallback = require('keystone-storage-namefunctions/ensureCallback');
var AWS = require("aws-sdk");
var nameFunctions = require('keystone-storage-namefunctions');
var pathlib = require('path');
var fs = require("fs");

var DEFAULT_OPTIONS = {
	key: process.env.S3_KEY,
	secret: process.env.S3_SECRET,
	bucket: process.env.S3_BUCKET,
	region: process.env.S3_REGION || 'us-east-1',
	generateFilename: nameFunctions.randomFilename,
};

// This constructor is usually called indirectly by the Storage class
// in keystone.

// S3-specific options should be specified in an `options.s3` field,
// which can contain the following options: { key, secret, bucket, region,
// headers, path }.

// The schema can contain the additional fields { path, bucket, etag }.

// See README.md for details and usage examples.

function S3Adapter (options, schema) {
	this.options = assign({}, DEFAULT_OPTIONS, options.s3);

	// Support `defaultHeaders` option alias for `headers`
	// TODO: Remove me with the next major version bump
	if (this.options.defaultHeaders) {
		this.options.headers = this.options.defaultHeaders;
	}

	// TODO: check for the 'key', 'secret' and 'bucket' options.
	
	this.client = new AWS.S3({
		params: {
			// included in every call, but may be overriden
			Bucket: this.options.bucket,
			ACL: this.options.acl
		},
		accessKeyId: this.options.key,
		secretAccessKey: this.options.secret,
		region: this.options.region
	});

	// If path is specified it must be absolute.
	if (options.path != null && !pathlib.isAbsolute(options.path)) {
		throw Error('Configuration error: S3 path must be absolute');
	}

	// Ensure the generateFilename option takes a callback
	this.options.generateFilename = ensureCallback(this.options.generateFilename);
}

S3Adapter.compatibilityLevel = 1;

// All the extra schema fields supported by this adapter.
S3Adapter.SCHEMA_TYPES = {
	filename: String,
	bucket: String,
	path: String,
	etag: String,
};

S3Adapter.SCHEMA_FIELD_DEFAULTS = {
	filename: true,
	bucket: false,
	path: false,
	etag: false,
};

// Return a knox client configured to interact with the specified file.
S3Adapter.prototype._knoxForFile = function (file) {
	// Clients are allowed to store the bucket name in the file structure. If they
	// do it'll make it possible to have some files in one bucket and some files
	// in another bucket. The knox client is configured per-bucket, so if you're
	// using multiple buckets we'll need a different knox client for each file.
	if (file.bucket && file.bucket !== this.options.bucket) {
		var s3options = assign({}, this.options, { bucket: file.bucket });
		return knox.createClient(s3options);
	} else {
		return this.client;
	}
};

// Get the full, absolute path name for the specified file.
S3Adapter.prototype._resolveFilename = function (file) {
	// Just like the bucket, the schema can store the path for files. If the path
	// isn't stored we'll assume all the files are in the path specified in the
	// s3.path option. If that doesn't exist we'll assume the file is in the root
	// of the bucket. (Whew!)
	var path = file.path || this.options.path || '/';
	return pathlib.posix.resolve(path, file.filename);
};

S3Adapter.prototype.uploadFile = function (file, callback) {
	var self = this;
	this.options.generateFilename(file, 0, function (err, filename) {
		if (err) return callback(err);

		// The expanded path of the file on the filesystem.
		var localpath = file.path;

		// The destination path inside the S3 bucket.
		file.path = self.options.path;
		file.filename = filename;
		var destpath = self._resolveFilename(file).slice(1);
		fs.readFile(localpath, function(err, fileData) {
			if (err) return callback(new Error("Read File Error: " + err.message));
			var params = {
				ContentLength: file.size,
				ContentType: file.mimetype,
				Body: fileData,
				Key: destpath
			};

			debug('Uploading file %s', filename);
			self.client.putObject(params, function (err, data) {
				if (err)
					return callback(new Error("Upload Error: " + err.message));


				// We'll annotate the file with a bunch of extra properties. These won't
				// be saved in the database unless the corresponding schema options are
				// set.
				file.filename = filename;
				file.etag = data.ETag; 

				// file.url is automatically populated by keystone's Storage class so we
				// don't need to set it here.

				// The path and bucket can be stored on a per-file basis if you want.
				// The effect of this is that you can have some (eg, old) files in your
				// collection stored in different bucket / different path inside your
				// bucket. This means you can do slow data migrations. Note that if you
				// *don't* store these values you can arguably migrate your data more
				// easily - just move it all, reconfigure and restart your server.
				file.path = self.options.path;
				file.bucket = self.options.bucket;

				debug('file upload successful');
				callback(null, file);
			});
		});
	});
};

// Note that this will provide a public URL for the file, but it will only
// work if:
// - the bucket is public (best) or
// - the file is set to a canned ACL (ie, headers:{ 'x-amz-acl': 'public-read' } )
// - you pass credentials during your request for the file content itself
S3Adapter.prototype.getFileURL = function (file) {
	if(this.options.region.indexOf("cn-north") != -1)
		return (
			"https://s3." +
			(this.options.region) +
			".amazonaws.com.cn/" + (file.bucket ||this.options.bucket) + 
			this._resolveFilename(file)
		);
	else
		return (
			"https://" +
			(file.bucket || this.options.bucket) +
			".s3.amazonaws.com" +
			this._resolveFilename(file)
		);
	// return this._knoxForFile(file).https(this._resolveFilename(file));
};

S3Adapter.prototype.removeFile = function (file, callback) {
	var param = {
		Bucket: this.options.bucket,
		Key: file.path.slice("1") + file.filename
	}
	this.client.deleteObject(param, function (err,data){
		if(err)
			return callback(Error('Delete Error: ' + err));
		else	
			callback();
	})
};

// Check if a file with the specified filename already exists. Callback called
// with the file headers if the file exists, null otherwise.
S3Adapter.prototype.fileExists = function (filename, callback) {
	var param = {
		Bucket: this.options.bucket,
		Key: (this.options.path || "/").slice(1) + filename
	};
	self.client.headObject(param, function(err, data) {
		if (err) return callback(err);

		if (!data) return callback(); // File does not exist
		callback(null, data);
	});
};

module.exports = S3Adapter;
