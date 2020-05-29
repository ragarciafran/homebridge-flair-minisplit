import {APIEvent} from 'homebridge';
import type {API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig} from 'homebridge';

import {PLATFORM_NAME, PLUGIN_NAME} from './settings';
import {FlairHVACPlatformAccessory} from './hvacPlatformAccessory';
import Client from './client';
import {Room, HVAC, Structure, FlairMode} from './client/models';
import {Model} from './client/models/model';
import {plainToClass} from 'class-transformer';

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class FlairPlatform implements DynamicPlatformPlugin {
    public readonly Service = this.api.hap.Service;
    public readonly Characteristic = this.api.hap.Characteristic;

    // this is used to track restored cached accessories
    public readonly accessories: PlatformAccessory[] = [];

    private client: Client;

    private structure?: Structure;

    private hvacs: [FlairHVACPlatformAccessory?] = []


    constructor(
        public readonly log: Logger,
        public readonly config: PlatformConfig,
        public readonly api: API,
    ) {
      this.log.debug('Finished initializing platform:', this.config.name);

      if (!this.validConfig()) {
        throw('The Flair config ixs no valid.');
      }

      this.client = new Client(this.config.clientId, this.config.clientSecret, this.config.username, this.config.password);

      // When this event is fired it means Homebridge has restored all cached accessories from disk.
      // Dynamic Platform plugins should only register new accessories after this event was fired,
      // in order to ensure they weren't added to homebridge already. This event can also be used
      // to start discovery of new accessories.
      this.api.on(APIEvent.DID_FINISH_LAUNCHING, async () => {
        log.debug('Executed didFinishLaunching callback');
        // run the method to discover / register your devices as accessories
        await this.discoverDevices();

        // setInterval(async () => {
        //   await this.getNewStructureReadings();
        // }, (this.config.pollInterval+ getRandomIntInclusive(1,20)) * 1000);

      });
    }


    private validConfig() {
      if (!this.config.clientId) {
        this.log.error('You need to enter a Flair Client Id');
        return false;
      }

      if (!this.config.clientSecret) {
        this.log.error('You need to enter a Flair Client Id');
        return false;
      }

      if (!this.config.username) {
        this.log.error('You need to enter your flair username');
        return false;
      }

      if (!this.config.password) {
        this.log.error('You need to enter your flair password');
        return false;
      }

      return true;
    }

    // private async getNewStructureReadings() {
    //   try {
    //     const structure = await this.client.getStructure(await this.getStructure());
    //     this.updateStructureFromStructureReading(structure);
    //   } catch (e) {
    //     this.log.error(e);
    //   }
    // }

    private updateStructureFromStructureReading(structure: Structure) {
      this.structure = structure;
      for (const hvac of this.hvacs) {
        if (hvac) {
          hvac.updateFromStructure(this.structure);
        }
      }
      return this.structure;
    }

    public async setStructureMode(mode: FlairMode): Promise<Structure> {
      const structure = await this.client.setStructureMode(await this.getStructure(), mode);
      return this.updateStructureFromStructureReading(structure);
    }

    private async getStructure(): Promise<Structure> {
      if (this.structure) {
        return this.structure!;
      }
      try {
        this.structure = await this.client.getPrimaryStructure();
      } catch (e) {
        throw('There was an error getting your primary flair home from the api: ' + e.message);
      }

      if (!this.structure) {
        throw('The structure is not available, this should not happen.');
      }

      return this.structure!;
    }

    /**
     * This function is invoked when homebridge restores cached accessories from disk at startup.
     * It should be used to setup event handlers for characteristics and update respective values.
     */
    configureAccessory(accessory: PlatformAccessory) {
      this.log.info('Restoring accessory from cache:', accessory.displayName);

      if (accessory.context.type === HVAC.type) {
        this.log.info('Restoring hvac from cache:', accessory.displayName);
        accessory.context.device = plainToClass(HVAC, accessory.context.device);
        accessory.context.device.room = plainToClass(Room, accessory.context.device.room);
        this.getStructure().then((structure: Structure) => {
          this.hvacs.push(new FlairHVACPlatformAccessory(this, accessory, this.client, accessory.context.device.room, structure));
        });
      }

      // add the restored accessory to the accessories cache so we can track if it has already been registered
      this.accessories.push(accessory);
    }

    /**
     * This is an example method showing how to register discovered accessories.
     * Accessories must only be registered once, previously created accessories
     * must not be registered again to prevent "duplicate UUID" errors.
     */
    async discoverDevices() {
      let currentUUIDs: string[] = [];

      const devices = (await this.client.getHVACs((await this.getStructure()))) as [HVAC];
      for (const device of devices) {
        const room = new Room();
        room.id = device.roomId;
        device.setRoom(await this.client.getRoom(room));
      }

      const promisesToResolve = [
        this.addDevices(devices),
      ];

      currentUUIDs = currentUUIDs.concat(...await Promise.all(promisesToResolve));

      //Loop over the current uuid's and if they don't exist then remove them.
      for (const accessory of this.accessories) {
        if (!currentUUIDs.find(uuid => uuid === accessory.UUID)) {
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          delete this.accessories[this.accessories.indexOf(accessory, 0)];
          this.log.debug('Removing not found device:', accessory.displayName);
        }
      }
    }

    async addDevices(devices: [Model]): Promise<string[]> {
      const currentUUIDs: string[] = [];

      // loop over the discovered devices and register each one if it has not already been registered
      for (const device of devices) {

        // generate a unique id for the accessory this should be generated from
        // something globally unique, but constant, for example, the device serial
        // number or MAC address
        const uuid = this.api.hap.uuid.generate(device.id!);
        currentUUIDs.push(uuid);

        // check that the device has not already been registered by checking the
        // cached devices we stored in the `configureAccessory` method above
        if (!this.accessories.find(accessory => accessory.UUID === uuid)) {

          // create a new accessory
          const accessory = new this.api.platformAccessory(device.name!, uuid);

          // store a copy of the device object in the `accessory.context`
          // the `context` property can be used to store any data about the accessory you may need
          accessory.context.device = device;


          // create the accessory handler
          if (device instanceof HVAC) {
            accessory.context.type = HVAC.type;
            this.getStructure().then((structure: Structure) => {
              this.hvacs.push(new FlairHVACPlatformAccessory(this, accessory, this.client, accessory.context.device.room, structure));
            });
          } else {
            continue;
          }
          this.log.info(`Registering new ${accessory.context.type}`, device.name!);

          // link the accessory to your platform
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);

          // push into accessory cache
          this.accessories.push(accessory);

          // it is possible to remove platform accessories at any time using `api.unregisterPlatformAccessories`, eg.:
          // this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        } else {
          this.log.debug('Discovered accessory already exists:', device.name!);
        }
      }

      return currentUUIDs;
    }

}
