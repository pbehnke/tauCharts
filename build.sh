#!/bin/bash

# We use uglifyjs to compress and minify js files. Read more info here https://github.com/mishoo/UglifyJS2

uglifyjs src/*.js src/charts/*.js  plugins/*.js -o taucharts.js -b
uglifyjs src/*.js src/charts/*.js  plugins/*.js -o taucharts.min.js -c -m

# Download all components
bower install