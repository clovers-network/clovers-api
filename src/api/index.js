import { version } from '../../package.json';
import { Router } from 'express';

import clovers from './clovers';
import users from './users';
import logs from './logs';

export default ({ config, db, io }) => {
	let api = Router();

  // mount the facets resource
  api.use('/clovers', clovers({ config, db, io }));

  // mount the facets resource
  api.use('/users', users({ config, db, io }));

  // mount the facets resource
  api.use('/logs', logs({ config, db, io }));

	// perhaps expose some API metadata at the root
	api.get('/', (req, res) => {
		res.json({ version });
	});

	return api;
}
