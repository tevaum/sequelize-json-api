var util = require('util')
  , _ = require('lodash')
  , Promise = require('bluebird')
  , express = require('express')
  , inflection = require('inflection')
  , validator = require('validator');

var Router = module.exports = function(sequelize, options) {
  var api = express.Router();
  var models = Object.assign(sequelize.models);;
  var transport;

    function token_fields(req, res, next) {
	console.log('[Router::Token]', req.token);
	next();
    }

    function process_includes(req, res, next) {
	req.locals.model.assocSetters = [];
	req.locals.model.includes = [];

	if ('include' in req.query) {
	    let assocs = req.query.include.split(',');

	    for (var i = 0; i < assocs.length; i++) {
		let assoc = assocs[i];
		if (!(assoc in req.locals.model.associations)) {
		    res.status(422).json(errors.assocDoesNotExist(req.locals.routename, assoc));
		    return;
		}

		let association = req.locals.model.associations[assoc];
		let targetName = association.as.toLowerCase();

		req.locals.model.assocSetters.push({
		    name: targetName,
		    setter: association.accessors.set
		});

		req.locals.model.includes.push({
		    model: models[targetName],
		    as: targetName
		});
	    }
	}
	next();
    };

  options = _.extend({
    endpoint: '/api',
    logLevel: 'info',
    allowed: Object.keys(models),
    allowOrigin: "",
    transport: "json-api",
    idValidator: validator.isInt
  }, options || {});
  
  transport = require('./transports/' + options.transport);

  api.use(function(req, res, next) {
    req.locals = req.locals || {};
    req.locals.options = options;
    res.set("Access-Control-Allow-Origin", options.allowOrigin);
    next(); // make sure we go to the next routes and don't stop here
  });

  var errors = {
      invalidResourceId: function(resource_id){
        return {
          errors: {
            title: "Invalid resource id",
            description: util.format("The resource id '%s' is invalid.", resource_id)
          }
        };
      },
      doesNotExist: function(routename, resource_id){
        return {
          errors: {
            title: "Resource does not exist",
            description: util.format("The resource /%s/%s does not exits.", routename, resource_id)
          }
        };
      },
      routeDoesNotExist: function(routename){
        return {
          errors: {
            title: "Route does not exist",
            description: util.format("The route /%s does not exits.", routename)
          }
        };
      },
      assocDoesNotExist: function(routename, association){
        return {
          errors: {
            title: "Association does not exist",
            description: util.format("The route /%s does have any association named %s.", routename, association)
          }
        };
      },
      notYetImplemented: function(){
        return {
          errors: {
            title: "Not yet implemented",
            description: "Deleting multiple resources is not yet implemented."
          }
        };
      }
  };


  api.options('/*',function(req,res){
    res.set('Access-Control-Allow-Headers', 'X-Requested-With, X-AUTHENTICATION, X-IP, Content-Type, Authorization');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.send('');//@TODO: check this
  });

  api.initialize = function (){
    // route /model
    api.route('/:resource')
      .all(function(req, res, next){
        if(req.params.resource in models){
          req.locals.model = models[req.params.resource];
          req.locals.model_name = inflection.singularize(req.params.resource.toLowerCase());
          req.locals.routename = inflection.pluralize(req.params.resource.toLowerCase());

          next();
        }else{
          res.json(errors.routeDoesNotExist(req.params.resource));
        }
      }, process_includes)
      .get(function(req, res) {
        req.locals.query_options = _.merge(
          {include: req.locals.model.includes},
          req.locals.query_options || {});
        req.locals.model
          .findAll(req.locals.query_options)
          .then(function(instances){
            var values = [];
            instances.forEach(function(instance){
              values.push(transport.serializeOne(req,instance));
            });
            ret = {};
            ret[req.locals.routename] = instances;
            res.json(ret);
          });
      })
      .post(token_fields, function(req, res) {
        req.locals.model
          .create(transport.deserialize(req))
          .then(function(instance){
            var values = transport.serializeOne(req,instance);
            ret = {}
            ret[req.locals.routename] = values;
            res.status(201).json(ret);
          })
          .catch(function(err){
              res.json({error: err, req: req.body});
          });
      });

    // route /model/id
    api.route('/:resource/:id')
      .all(function(req, res, next){
        if(req.params.resource in models){
          req.locals.model = models[req.params.resource];
          req.locals.model_name = inflection.singularize(req.params.resource.toLowerCase());
          req.locals.routename = inflection.pluralize(req.params.resource.toLowerCase());

          if(!options.idValidator(req.params.id)){
            res.json(errors.invalidResourceId(req.params.id));
          }else{
            next();
          }
        }else{
          res.json(errors.routeDoesNotExist(req.params.resource))
        }
      })
      .get(function(req, res) {
        if(req.params.id.indexOf(',') > 0){
          res.json(errors.notYetImplemented());
        }else{
          if (validator.isInt(req.params.id)) req.params.id = validator.toInt(req.params.id);
          req.locals.query_options = _.merge(
            {where: {id: req.params.id}, include: req.locals.model.includes},
            req.locals.query_options || {});
          req.locals.model
            .find(req.locals.query_options)
            .then(function(instance){
              if(instance){
                var values = transport.serializeOne(req,instance);
                ret = {};
                ret[req.locals.routename] = values;
                res.json(ret);
              }else{
                res.json(errors.doesNotExist(req.locals.routename, req.params.id))
              }
            })
            .catch(function(err){
              res.send('error');
            });
        }
      })
      .put(token_fields, function(req, res) {
        var model = req.locals.model;
        var routename = req.locals.routename;
        var attributes = transport.deserialize(req);
        //if (validator.isInt(req.params.id)) req.params.id = validator.toInt(req.params.id);
        req.locals.query_options = _.merge(
          {where: {id: req.params.id}, include: model.includes},
          req.locals.query_options || {});
        model
          .find(req.locals.query_options)
          .then(function(instance){
            if(instance){
		// run the setters
              Promise.map(model.assocSetters || [], function(assoc){
                if(attributes[assoc.name] && attributes[assoc.name].length > 0){
                  // get the linked objects
                  return Promise.map(attributes[assoc.name], function(assocId){
                    return models[assoc.name].find({where: {id: assocId}});
                  }).then(function(assocList){
                    // filter items that weren't found
                    assocList = assocList.filter(function(n){ return n != undefined });
                    // remove from attributes
                    delete attributes[assoc.name];
                    return instance[assoc.setter](assocList);
                  });
                }else if(attributes[assoc.name]){
                  // empty association
                  return instance[assoc.setter]([]);
                }else{
                  return;
                }
              }).then(function(){
                  // finally update attributes
		  console.log('[Put]', attributes);
                instance
                  .updateAttributes(attributes)
                  .then(function(instance) {
                    instance
                      .reload(req.locals.query_options)
                      .then(function(instance) {
                        var values = transport.serializeOne(req,instance);
                        ret = {};
                        ret[routename] = values;
                        res.json(ret);
                      });
                  });
              }).catch(function(err){
                res.send('error');
              });
            }else{
              res.json(errors.doesNotExist(routename, req.params.id))
            }
          })
          .catch(function(err){
            res.send('error');
          });
      })
      .delete(function(req, res) {
        if(req.params.id.indexOf(',') > 0){
          res.json(errors.notYetImplemented())
        }else{
          if (validator.isInt(req.params.id)) req.params.id = validator.toInt(req.params.id);
          req.locals.query_options = _.merge(
            {where: {id: req.params.id}},
            req.locals.query_options || {});
          req.locals.model
            .find(req.locals.query_options)
            .then(function(instance){
              if(instance){
                instance
                  .destroy()
                  .then(function(){
                    res.status(204).send('');
                  })
              }else{
                res.json(errors.doesNotExist(req.locals.routename, req.params.id))
              }
            });
        }
      });
    api.route('/:resource/:id/:collection')
      .all(function(req, res, next){
        req.locals.model = models[req.params.collection];
        req.locals.routename = inflection.pluralize(req.params.resource.toLowerCase());
        req.association = models[req.params.resource];

        req.identifier = req.locals.model.associations[req.association.name].as;

        if(!options.idValidator(req.params.id)){
          res.json(errors.invalidResourceId(req.params.id))
        }else{
          next();
        }
      })
      .get(function(req, res) {
        req.locals.query_options = _.merge(
          {
            where:{},
            include: req.locals.model.includes
          },
          req.locals.query_options || {});
        req.locals.query_options.where[req.identifier] = req.params.id;
        req.locals.model
          .findAll(req.locals.query_options)
          .then(function(instances){
            var values = [];
            instances.forEach(function(instance){
              values.push(transport.serializeOne(req,instance));
            });
            ret = {}
            ret[req.locals.routename] = instances;
            res.json(ret);
          });
      });
  }
  return api;
}
