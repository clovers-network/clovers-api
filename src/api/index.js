import { version } from '../../package.json';
import { Router } from 'express';

import clovers from './clovers';

export default ({ config, db, io }) => {
	let api = Router();

	// mount the facets resource
  api.use('/clovers', clovers({ config, db, io }));

	// perhaps expose some API metadata at the root
	api.get('/', (req, res) => {
		res.json({ version });
	});

	return api;
}
