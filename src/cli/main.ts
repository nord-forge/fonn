#!/usr/bin/env node
import { dispatch } from '@nord-forge/fonn-cli';
process.exitCode = await dispatch(process.argv.slice(2));
